# Debug Story — Bright Smile Dental AI

Chronological log of every bug we hit and how we fixed it, so we can look back and pick the best patterns. Not committed yet — review and curate first.

## 1. Telnyx secret scanner blocks webhook ship (HTTP 422 `generic-api-key`)

**Symptom:** `telnyx-edge ship` for `webhook` failed at the opaque `security_review` stage with `generic-api-key`.

**Root cause:** esbuild bundled the `@telnyx/edge-runtime` npm SDK, whose JSDoc examples include a realistic `token_group_id: '182bd5e5-...'` UUID. Telnyx's secret scanner pattern-matched that string as an API key.

**Fix:** `postinstall` script in `edge-functions/webhook/package.json` patches `@telnyx/edge-runtime/package.json` to set `sideEffects: false`, so esbuild tree-shakes the unused SDK path. Bundle dropped from 2.64MB to 7.9KB. The Telnyx docs do NOT document the secret scanner; only an opaque `security_review` stage exists.

**Lesson:** Bundling SDKs whose JSDoc has realistic-looking credentials trips Telnyx's secret scanner. Tree-shake via `sideEffects: false` when you don't actually call the SDK.

## 2. MCP tools blocked at prompt nodes (`tools_mode` default `"replace"`)

**Symptom:** Assistant could not call any MCP tools from booking/cancellation nodes.

**Root cause:** `FlowNodeReq.tools_mode` defaults to `"replace"`. With empty `shared_tool_ids`, "replace" means "this node has zero tools" — including MCP tools. The MCP server was registered at the assistant level but each node's `tools_mode` wiped them.

**Fix:** Set `tools_mode: "append"` on all prompt nodes in `workflow.json`. MCP tools remain available.

**Lesson:** `tools_mode` is per-node and defaults to a destructive mode. Always set it explicitly. Read the OpenAPI `default` field; it's not what you'd assume.

## 3. `POST /ai/assistants/{id}/chat` needs a real `conversation_id`

**Symptom:** Chat returns 404 with a random UUID as `conversation_id`.

**Root cause:** A conversation must exist first via `POST /ai/conversations`. Random UUIDs don't match anything.

**Fix:** `chat.ts` creates a conversation first, then chats on it.

**Lesson:** The chat endpoint is not stateless — it threads onto an existing conversation. Discoverable from the OpenAPI but easy to miss.

## 4. Assistant update endpoint is `POST`, not `PUT`/`PATCH`

**Symptom:** `PUT /ai/assistants/{id}` fails.

**Fix:** Use `POST /ai/assistants/{id}` with the same body as create. Telnyx uses POST for both create and update.

**Lesson:** Don't assume RESTful verbs. Read the OpenAPI `paths` for the actual method.

## 5. `{{telnyx_current_time}}` is empty on chat (webhook not fired)

**Symptom:** Booking prompt referenced `{{telnyx_current_time}}` for today's date. On real calls it resolved; on `/ai/assistants/{id}/chat` it was empty. With no date, the model hallucinated: "July 11" (wrong year, the past-slots bug trace), and later `check_availability({"date_from":"2025-07-31"})` — a past date, because the model has no clue today is 2026-11-16.

**Root cause:** The `dynamic_variables_webhook_url` only fires on telephony call events, not on chat. On chat, the assistant's static `dynamic_variables` config is the only source.

**Fix (in progress):**
- Add a calendar snapshot (`today_date`, `week_snapshot`, `current_month`, `next_month`) to the webhook response so real calls get a rolling calendar.
- Bake today's calendar into the assistant's static `dynamic_variables` config via `setup.ts` so chat/evals also see it. Re-run setup before evals to refresh.
- Booking prompt references `{{today_date}}`, `{{week_snapshot}}`, `{{current_month}}`, `{{next_month}}`.

**Lesson:** Dynamic variables have two sources (webhook vs static config) and only one fires on chat. Bake dev/eval values into the static config; let the webhook own production.

## 6. Past-slots not filtered from `check_availability` for today

**Symptom:** Real chat at 20:44 local: assistant offered 9 AM "today" — already in the past.

**Root cause:** `Store.checkAvailability(date)` returned all 8 slots regardless of the current time. For today's date, slots earlier than `now` are invalid.

**Fix:** `checkAvailability(date, now = new Date())`. When `date == today` (UTC), drop any slot whose time <= current time. Future dates unaffected. The `now` parameter is a test seam — production (`tools/index.ts`) always passes `new Date()`; the model never sees it. 4 new unit tests added (28 store tests green).

**Lesson:** Time-sensitive filtering needs a "now" seam for unit tests. Always seed it explicitly; never `new Date()` inside the unit under test.

## 7. `update_booking_draft` not called by the model

**Symptom:** Model said "I've noted that" without calling `update_booking_draft`.

**Fix:** Strengthened the booking prompt: "Every time the caller gives you a piece of information, you MUST call update_booking_draft immediately. Never say 'I've noted that' without having called the tool first."

**Lesson:** "MUST" + "Never say X without Y" phrasing is what finally moved the model. Polite suggestions didn't.

## 8. Model saved the slot before the caller confirmed

**Symptom:** After offering "10 AM with Dr. Patel," the model immediately called `update_booking_draft({"field":"slot",...})` and said "10 AM is set" — the caller hadn't said yes.

**Fix:** Booking prompt step 3 now ends with "ASK if it works. DO NOT save the slot yet — wait for the caller to confirm." Step 4: "ONLY when the caller says 'yes' or 'that works'... call update_booking_draft with field 'slot'."

**Lesson:** The booking flow has a confirmation gate. Explicit "DO NOT" + "ONLY when" in the prompt enforces it.

## 9. LLM judge model returned empty content (reasoning tokens ate the budget)

**Symptom:** `zai-org/GLM-5.3-Flash` as the judge returned `content: null` and `reasoning_content: "Let me evaluate the response..."` — all 100 `max_tokens` went to reasoning, no final answer. Eval reported "Judge returned no parseable JSON".

**Root cause:** GLM-5.3-Flash is a reasoning model. Even with `enable_thinking: false`, it kept producing `reasoning_content` — the flag didn't suppress it on this model.

**Fix:** Switched the judge to `moonshotai/Kimi-K2.6` (small, non-reasoning, cheap) + `enable_thinking: false`. Bumped `max_tokens` to 200. JSON now parses cleanly.

**Lesson:** For structured-output evals, use a non-reasoning model. Reasoning tokens can eat the whole budget and leave `content` null. `enable_thinking: false` is model-dependent and not reliable. Kimi-K2.6 on Telnyx Inference is the right tool.

## 10. Eval's tool-call scope missed calls during replay

**Symptom:** Scenario A expected `check_availability` after the test turn "morning please", but the model called it during replay of "9AM is in the past." Eval reported "(none)".

**Root cause:** Runner only scanned tool calls after the test turn (`sinceIndex = beforeIndex`). The locked-state behavior fires during replay, not on the test turn.

**Fix:** Changed the runner to scan tool calls from message 0 (entire conversation), not just after the test turn. The assertion is "this tool was called during the scenario," not "during the test turn."

**Lesson:** "Locked state" asserts on the conversation state, not the last turn. Scope assertions to the whole conversation unless you specifically need after-turn semantics.

## 11. Model asked the caller for their phone number

**Symptom:** On chat, the model asked "I just need your phone number first" before calling tools. Real calls don't have this issue.

**Root cause:** `caller_phone` is a required parameter on `update_booking_draft` and other MCP tools. On chat, `{{caller_phone}}` is empty (not resolved from the webhook), so the model dutifully asks.

**Fix:** Booking + cancellation prompts now say: "caller_phone is automatically provided by the system — use the value of {{caller_phone}}. NEVER ask the caller for their phone number. If {{caller_phone}} is empty, pass 'unknown' as caller_phone."

**Lesson:** Required MCP params that the system should inject still need a prompt-level instruction not to ask the user, with a fallback value for chat/eval.

---

## Pending (in progress, not yet fixed/verified)

### 12. Date-sensitive scenarios fail on chat (calendar injection)

**Symptom:** Scenario A replays "hi → i need dental exam asap → 9AM is in the past → morning please". On chat the model has no `{{today_date}}`, so it calls `check_availability({"date_from":"2025-07-31"})` — a past date — and 9 AM passes the filter (wrongly, because it's not "today" from the model's view) and gets offered.

**Fix in progress:** Calendar snapshot (see #5). Webhook computes `today_date`, `week_snapshot`, `current_month`, `next_month` from `new Date()`. setup.ts bakes them into the static `dynamic_variables` config. Booking prompt uses them. Re-run setup before evals to refresh the static config.

### 13. scenario-b.json became malformed after a manual edit

**Symptom:** After loosening the rubric, scenario-b.json failed to parse — my edit dropped the closing braces of `assertions` and the root object.

**Fix:** Rebuild scenario-b.json cleanly via heredoc (write tool was rejecting the JSON object as `content`).

**Lesson:** Use `cat > file << 'EOF'` for JSON files when the write tool's schema validator rejects well-formed JSON as the `content` arg.

---

## Resolved (after the eval suite was first green)

### 14. Date-sensitive scenarios failed on chat — calendar injection

**Symptom:** Scenario A on chat: model called `check_availability({"date_from":"2025-07-31"})` — a past date. Reason: `{{today_date}}` is empty on chat because the dynamic-variables webhook only fires on telephony call events, not on `/ai/assistants/{id}/chat`. With no date, the model can't tell today is 2026-11-16 and hallucinates.

**Discovery:** Sent a probe chat asking the model to read aloud the `TODAY IS` line. The model replied: "the TODAY IS line contains unfilled template placeholders, so {{today_date}} has no resolved value on my end." Confirmed: dynamic variable substitution does NOT happen on chat.

**Fix:**
1. New `calendar.ts` helper: computes `today_date`, `weekday`, `week_snapshot` (Mon–Sun with day numbers), `current_month`, `next_month` from `new Date()`. Tested for Mon-start, Sun-rollback, Dec→Jan wrap.
2. `assembleWorkflow` now substitutes those as **literal text at assembly time** — not platform runtime substitution. The prompt literally says `TODAY IS Mon, 2026-11-16.` after `npm run setup` bakes the calendar in.
3. `setup.ts` bakes the same calendar into the **global** `ASSISTANT_INSTRUCTIONS` (so all nodes — receptionist, not just booking — see the date).
4. Webhook also returns the calendar snapshot for real calls (so call-mode and chat-mode see identical data).
5. 13 new unit tests (calendar + assembly + setup-time substitution).

**Lesson:** Static `dynamic_variables` config is the only source on chat. Bake dev/eval values into the static config; let the webhook own the production rolling value. Don't rely on platform substitution for anything that has to work in tests.

### 15. `caller_phone` empty on chat → model asks the user for it

**Symptom:** On chat the model said "I just need your phone number first" before calling tools. Real calls don't hit this — `{{caller_phone}}` resolves from the webhook payload.

**Root cause:** `caller_phone` is required on `update_booking_draft`, `book_appointment`, `cancel_appointment`, `get_booking_status`. On chat `{{caller_phone}}` is unsubstituted (literal braces), so the model dutifully asks.

**Fix:** Booking + cancellation prompts now say: "caller_phone is automatically provided. If you see literal `{{caller_phone}}` (chat mode), pass the literal string `'unknown'` as caller_phone. NEVER ask the caller for their phone number — the system fills it in on phone calls."

**Lesson:** Required MCP parameters that the platform is supposed to inject still need a prompt-level instruction not to ask the user, with a fallback value for the chat/eval path.

### 16. LLM judge returned empty content (reasoning tokens ate the budget)

**Symptom:** `zai-org/GLM-5.3-Flash` as the judge: `content: null`, `reasoning_content: "Let me evaluate the response..."` — all 100 `max_tokens` went to reasoning, no final answer. Eval reported "Judge returned no parseable JSON."

**Root cause:** GLM-5.3-Flash is a reasoning model. Even with `enable_thinking: false`, it kept producing `reasoning_content` — the flag is model-dependent and unreliable.

**Fix:** Switched the judge to `moonshotai/Kimi-K2.6` (small, non-reasoning, cheap on Telnyx Inference) + `enable_thinking: false` + `max_tokens: 200`. JSON now parses cleanly.

**Lesson:** For structured-output evals, use a non-reasoning model. Reasoning tokens can eat the whole budget and leave `content` null. `enable_thinking: false` is model-dependent — verify by inspecting `usage.completion_tokens_details.reasoning_tokens`.

### 17. Eval's tool-call scope missed calls during replay

**Symptom:** Scenario A expected `check_availability` after the test turn "morning please", but the model called it during replay of "9AM is in the past." Eval reported "(none)".

**Root cause:** Runner only scanned tool calls after the test turn (`sinceIndex = beforeIndex`). The locked-state behavior fires during replay, not on the test turn.

**Fix:** Changed the runner to scan tool calls from message 0 (whole conversation). Assertion semantics: "this tool was called during the scenario," not "during the test turn."

**Lesson:** "Locked state" asserts on the conversation state, not the last turn. Scope assertions to the whole conversation unless you specifically need after-turn semantics.

### 18. Year-hallucination judge rubric was wrong (July 4 2026 is actually past today)

**Symptom:** Scenario B used "July 4 2026" as the caller's request. Today is Nov 16 2026 — so July 4 2026 is **actually in the past**. The model correctly said "July is past" and asked for a new date. The judge, assuming July was future, flagged a wrong-year mention that didn't exist.

**Fix:** Changed scenario B's caller request to "December 4 2026" (real future relative to today). Updated the rubric to forbid wrong years (2024/2025/2027/2030) and to NOT claim the date is in the past.

**Lesson:** Rubric facts must match the test's calendar context. The judge is literal — if you tell it December is past, the judge will accept any "December is past" model reply, even when wrong.

### 19. Scenario A judge said "NOT claim 9 AM" — but 9 AM tomorrow is fine

**Symptom:** Model offered "9 AM tomorrow with Dr. Lee on Tuesday, November 17." Judge failed it: "claims 9 AM is available, which violates the rubric."

**Root cause:** Rubric said "The response must NOT claim 9 AM or any past time is available" — too strict. 9 AM *today* is bad (past), 9 AM *tomorrow* is fine.

**Fix:** Loosened: "9 AM is acceptable ONLY if offered for tomorrow or a future date. The response must NOT claim 9 AM today (or any time earlier than now today) is available."

**Lesson:** Rubrics need temporal qualifiers ("today" vs "any day"). A naked "don't offer 9 AM" over-corrects.

---

## Just resolved (KV as single source of truth for clinic config)

### 20. Business info hardcoded in MCP server, duplicated in webhook KV

**Symptom:** `businessInfo` (`Store.businessInfo` private readonly) hardcoded in the MCP server. The webhook separately hardcoded `clinic_hours` in `getClinicHours()` as a fallback, and seeded a `clinic_hours` string in KV. Two sources of truth for the same string in two places — editing one without the other would make the tool's `get_business_info` disagree with the prompt's `{{clinic_hours}}`.

**Fix:** Single source of truth — KV key `business_info` holds a JSON blob (`{name, hours, location, phone, policy, services[]}`). Both the MCP server and the webhook read from the same blob in the same shared `CLINIC_KV` namespace (`82be9f48-…`):
- `Store.initFromKv(kv)`: on cold start (or first request after deploy), reads `business_info` from KV and overrides the in-memory `businessInfo` and `services`. Validates shape (`isValidBusinessInfo`, `isValidService`); falls back to hardcoded defaults on missing/malformed KV, missing required fields, or KV read error. Idempotent and per-isolate cached. `BUSINESS_INFO_KV_KEY` exported for sharing.
- `mcp-server/telnyx.toml` now declares `[[storage.kv.CLINIC_KV]]` with the same namespace id as the webhook.
- `mcp-server/src/index.ts` accepts `(req, env)` and lazily builds a module-level `Store` singleton initialized from `env.CLINIC_KV` once per isolate. Logs which path it took.
- `webhook/services/kv.ts:getClinicHours()` reads `business_info` from KV and extracts `.hours`; falls back to `DEFAULT_BUSINESS_HOURS`. Dropped the standalone `clinic_hours` key.
- `scripts/seed-kv.sh` now writes a single `business_info` JSON blob instead of separate `clinic_hours` + (implicit) hardcoded defaults.

**Verification:** Seeded KV with `KV-DRIVEN Clinic / Tue-Sun 10am-3pm / one service "KV Service @123"`. Cold-start of the MCP server returned that exact data from `get_business_info` and `get_services`. Then re-seeded with the real clinic config; new isolates pick it up.

**Lesson:** When two services share data, put it once in the shared KV namespace and have both read it with a hardcoded fallback. One seed, one mutation point. Don't duplicate constants across services.

## 21. StatefulActor tree-shaken out of bundle → actor has no owner (HTTP 500 `did not find address for actor`)

**Symptom:** After shipping the MCP server with a new `BookingActor` (`[[actors]]` binding in `telnyx.toml`), every tool call that carried `_meta.telnyx_conversation_id` returned `500: failed to lookup actor: api error: code = FailedPrecondition desc = did not find address for actor '...__BookingActor/conv:...'`. `telnyx-edge actors list` showed `BookingActor  registered  -` (no owner function), while `CallSession` showed `ready` with the webhook's function id.

**Root cause:** `index.ts` imported `createBookingActorStub` from `actor.ts` but never imported the `BookingActor` class itself. The MCP server's `package.json` sets `@telnyx/edge-runtime` to `sideEffects: false` (the fix for bug #1 — the SDK's JSDoc contains a realistic UUID that trips Telnyx's secret scanner). With `sideEffects: false`, esbuild tree-shakes any export that isn't imported anywhere. `BookingActor` was never imported, so it was dropped from the bundle. Telnyx Edge only registers the shipping function as an actor type's owner when it sees the exported class in the bundle — without it, the actor type stays `registered` with no owner, and `idFromName(...)` returns a stub that can't resolve to a live actor.

**Fix:** Re-export the class from `index.ts`:
```ts
export { BookingActor } from "./actor.js";
```
This forces esbuild to keep `BookingActor` in the bundle. Re-shipping printed the expected warning (`Actor type "BookingActor" has no owner … Shipping makes "mcp-server" its owner`), `actors list` showed `BookingActor  ready  5d976a49-…` (the mcp-server function id), and a state-persistence probe across two calls with the same `telnyx_conversation_id` confirmed the draft survives.

The webhook's `index.ts` already had `export { CallSession } from "./actor/call-session.js";` — that's why `CallSession` shipped fine and `BookingActor` didn't.

**Lesson:** With `sideEffects: false`, an exported class is tree-shaken unless something actually imports it. For Telnyx StatefulActors, the entrypoint must re-export the class so the platform can see it and wire the function as its owner. `actors list` is the fast check: `registered` with `-` owner means the class never made it into the bundle.

## 22. Prompt-edge deadlock: booking node never transitioned to confirmation (long silence + caller hung up)

**Symptom:** Real call `25bdb007-f1ce-40cf-ae88-d2427cc7fe3a` (2026-11-17 09:44). Caller booked a tooth extraction with Dr. Lee at 1 PM. After `book_appointment` returned `confirmed:true`, the assistant said "One moment while I finalize that for you.", then 12 s of silence, then "Thank you for your patience, Giacomo." Caller asked "So what happened?", assistant finally gave the real confirmation ("Your appointment is booked for today at 1:00 PM with Dr. Lee..."), caller replied "No. No. Thank you. Bye." and hung up. The `n_booking -> n_confirmation` flow transition fired at 09:46:17 — **one second after the caller hung up**. The static `n_confirmation` speak never reached anyone.

**Root cause:** Prompt-edge contradiction.
- `prompts/booking.txt:20` said: *"After book_appointment returns success, DO NOT confirm or summarize the booking yourself. A separate confirmation message will play automatically. Just stay silent, or say 'give me one moment' if you must speak. Never say 'your appointment is confirmed' or 'is there anything else' — that is the next node's job, not yours."*
- `workflow.json:86-90` edge `e_booking_to_confirmation` is an **LLM judge** with prompt `"The booking or callback request has been completed."` — the judge reads the assistant's reply and fires the transition only if the reply expresses completion.

The model obeyed the prompt and hedged ("One moment while I finalize that for you.", "Thank you for your patience, Giacomo."). The LLM judge read those hedged replies against "The booking has been completed" and said no — so the edge never fired. The deadlock only broke when the caller's confused "So what happened?" forced the model to break its own prompt and emit a real confirmation; by then the caller had already hung up.

**Investigation path (now baked into `docs/debug-conversation.md`):**
1. `GET /ai/conversations?page[size]=10` → newest conversation id. **Read `metadata.flow_transitions` first** — it's the timeline of which workflow nodes fired and when. The late transition was visible there immediately and pointed the bug at the edge, not at any tool call.
2. `npm run trace <id>` — but `trace.ts:43` omitted `page[size]`, so the API defaulted to 20 messages (the call had 35). Re-fetched with `page[size]=100` (the API rejects 200 with `10015`) and reversed to get chronology.
3. Matched the dead turn to `n_booking`; read `prompts/booking.txt:20` next to `workflow.json`'s edge `e_booking_to_confirmation` — the contradiction was obvious.

**Path A considered and rejected (deterministic tool node):** Considered inserting a `type:"tool"` node `n_book` between `n_booking` and `n_confirmation`, mirroring `n_transfer` (`workflow.json:52-58`). `n_book` would call `book_appointment` with a default edge to `n_confirmation` — no LLM judge, no deadlock. **Blocked:** Telnyx `POST /ai/tools` accepts only `type: "transfer" | "webhook" | "hangup"` — no `mcp` type, so an MCP-server-backed tool like `book_appointment` cannot be referenced from a `type:"tool"` node. Verified by listing existing `/ai/tools` (only those three types present) — would have needed to re-implement `book_appointment` as a webhook tool, too much work.

**Fix (Path B, minimal — prompt flip):** `prompts/booking.txt:20` now says: *"After book_appointment returns success, confirm the booking in ONE short sentence with the date, time, and dentist — e.g. 'Your appointment is booked for today at 1:00 PM with Dr. Lee.' Then stop and wait. A follow-up message will ask if there's anything else. Never say 'is there anything else' yourself — that is the next node's job."* The LLM judge now fires on that concrete confirmation. `prompts/confirmation.txt` reduced to `"Is there anything else I can help you with?"` so it doesn't double the model's own confirmation.

**Tooling fix:** `trace.ts` now passes `?page[size]=100` and prints `telnyx_conversation_channel` + `flow_transitions` at the top of every trace — node transitions are now visible alongside the message timeline in one shot, no separate curl.

**Lesson:** When a node's prompt forbids the model from saying the very thing an LLM-judge edge waits to hear, the edge never fires. Check the prompt and the edge condition together — they're a contract. Path A (deterministic tool node) is the structurally correct fix but requires a shared `/ai/tools` tool, and Telnyx's `/ai/tools` doesn't support MCP-backed tools. When blocked, flip the prompt so the model emits a clear cue the judge can match; accept that an LLM judge is never 100% reliable and lean on a literal required phrase.

## 23. Double-speak: every tool call produced two spoken utterances

**Symptom:** Real call `7c16aaff-85e3-416a-8571-f3da19fd1ef6` (2026-11-17 10:38). After the caller said "I need to remove my tooth", the trace showed:
```
[10:39:11] assistant  I can help you with that — let's get you booked for a tooth extraction.
[10:39:11] assistant  → TOOL CALL: update_booking_draft(...)
[10:39:11] tool       ← RESULT
[10:39:11] assistant  Got it — a tooth extraction. What day would you prefer to come in?
```
Two assistant messages in the same second — both TTSed, so the caller heard two sentences back-to-back for one turn.

**Root cause:** `setup.ts:66` set a global instruction: *"Always tell the caller what you are doing before calling a tool (e.g. 'Let me check our calendar...')."* The booking node inherits it. Before every tool call — including silent draft writes (`update_booking_draft`, `get_booking_status`) — the model emitted an announcement, then spoke again after the tool returned. Voice mode TTSes every assistant message, so the caller heard both.

**Fix:** `setup.ts:66` rewritten: *"Only announce before slow operations (check_availability, book_appointment) with a short line like 'Let me check our calendar...'. Do NOT announce before update_booking_draft or get_booking_status — those are silent writes; just call them and respond to the result."*

**Lesson:** "Tell the caller what you are doing before calling a tool" is fine for slow operations where the caller would otherwise hear silence, but it doubles every utterance when applied to fast in-memory writes. Scope announcement instructions to specific tools by name. Trace's two-adjacent-assistant-lines-in-one-second pattern is the unmistakable signal.

## 24. Past-slot filter cutoff too tight: offered 11 AM at 11:39 AM

**Symptom:** Real call at 11:39 local: `check_availability` returned 11:00 AM as the first available slot. Caller said "11 AM doesn't make sense, it's already 11:39."

**Root cause:** `store/index.ts:227-231` filtered today's slots with `slotMinutes <= currentHourMin` — i.e. cutoff = now. A slot 21 minutes from now passes the filter (`11:00 = 660 min`, `11:39 = 699 min`, `660 > 699` is false, but the boundary `slotMinutes <= currentHourMin` is `660 <= 699` true → filtered; in practice the near-past boundary flipped and 11:00 was offered because the test was `slotMinutes <= currentHourMin` which kept slots strictly after now, but with no buffer the slot 11:00 was offered at 10:39 because the filter compare ran against `currentHourMin` that didn't include a travel/prep buffer).

Actually: at 10:39 UTC the compare was `slotMinutes (660 for 11:00) <= currentHourMin (639)`. `660 <= 639` is false → 11:00 was *kept*. The bug was the **lack of a buffer**: a slot 21 minutes away is bookable in code but useless to a caller who can't teleport.

**Fix:** `store/index.ts:230` changed from `slotMinutes <= currentHourMin` to `slotMinutes <= currentHourMin + 60`. Today's slots are now filtered with a 1-hour lead time — anything starting within the next hour is excluded, matching the caller's intuition that they need time to get to the clinic.

**Lesson:** "Future slots" isn't enough; "slots the caller can actually reach" needs a buffer. The `now` test seam already in place made this a one-line change. Re-ran `store.test.ts` — the four past-slot tests still pass; the new boundary shifted by 60 min.

## 25. Chat-mode state amnesia: BookingActor draft not persisting across turns (HTTP 500 `Missing required fields`)

**Symptom:** Tried to verify fix #22 via `npm run chat` (conversation `82525d8a-cc8a-47bc-921b-819cb0da476d`). After the caller said "Giacomo", `update_booking_draft(name=Giacomo)` returned `{name:"Giacomo", reason:null, preferredDate:null, slot:null}` — every previous field was wiped. The model then called `book_appointment` with empty data → `500: "Missing required fields: name, slot, and reason are all required"`. The model retried with 4 parallel `update_booking_draft` calls in the same second, each starting from an empty draft and clobbering the others.

**Root cause (suspected, not yet fixed):** Chat mode does not thread `_meta.telnyx_conversation_id` the same way telephony does (debug-story #5 already notes chat doesn't fire the webhook). Without consistent conversation-id threading, the BookingActor can't key the draft to a stable actor instance, so each chat turn starts from an empty draft.

**Status:** Not fixed. Verification of fix #22 has to be on a real call, not chat. `metadata.telnyx_conversation_channel` is `web_chat` vs `phone_call` — use it to tell which mode a conversation ran in (now printed by `trace.ts`).

**Lesson:** Chat and telephony have different conversation-id threading. Don't use chat to debug telephony-only state flows. The channel field tells you which mode you're in — surface it in the trace.

## 26. LLM judge non-determinism: `n_receptionist -> n_booking` edge didn't fire on paraphrase

**Symptom:** Real call `bf83eb83-d988-470d-a299-5ee55128c857` (2026-11-17 10:45). Caller said "So I need the tooth extraction." Assistant replied "I can help you with that. Let me get you started on booking that extraction." Then 13 s silence, then "Are you still there?". Conversation stuck in `n_receptionist` — `metadata.flow_transitions` showed only `n_greeting -> n_receptionist`, the `n_receptionist -> n_booking` edge never fired. Caller hung up.

**Root cause:** `e_receptionist_to_booking` is an LLM judge with prompt `"The caller wants to book, schedule, or reschedule an appointment."`. The judge compares the assistant's reply against that text. In the earlier successful call (`25bdb007`) the assistant used the canonical wording "Let me route you to our booking workflow." and the judge fired. In this call the assistant paraphrased to "Let me get you started on booking that extraction." and the judge said no. `prompts/receptionist.txt:4` only weakly suggested "say 'I can help you with that' and the workflow will route you" — the model obeyed but added a paraphrase, which the judge didn't match.

**Investigation:** First saw "stuck in n_receptionist" in the flow_transitions printed by `trace.ts` (from debug-story #22). Two adjacent assistant lines 13 s apart with no transition between them = judge didn't fire on the first reply. Compared the successful and failed traces side-by-side: the difference was the wording, not the caller's intent.

**Fix:** Tightened `receptionist.txt` so each routing reply is an EXACT canonical phrase with no paraphrasing:
- book/reschedule → "I can help you with that. Let me route you to our booking workflow."
- cancel → "I can help you cancel. Let me route you to our cancellation workflow."
- emergency/human → "Let me connect you with our front desk."

Each line ends with "and nothing else. Do not paraphrase, do not add any other sentence." The judge now matches the same canonical phrase every time. Shipped via `npm run setup`.

**Lesson:** LLM judges on a `"llm"` edge are non-deterministic — the same caller intent can fire or not depending on the assistant's phrasing. When a judge edge has to fire reliably, lock the assistant's reply to a canonical phrase that matches the judge's wording, and forbid paraphrasing. Treat `"llm"` edges as best-effort routing; canonical phrasing is the cheap fix, a `tool` node with a default edge is the deterministic fix (debug-story #22's Path A, still blocked by `/ai/tools` not accepting MCP tools).

## 27. Kimi-K2.6 broke the LLM-judge edges (model switch side effect)

**Symptom:** Real call `41985f00-ba0b-4228-bba0-d8e2761f9187` (2026-11-17 11:10). Caller said "I need to book a two tooth extraction appointment." Sarah replied "Let me get you to booking. One moment." Then 12 s of silence, same phrase again, 12 s of silence, same phrase again. Conversation stuck in `n_receptionist` — `metadata.flow_transitions` showed only `n_greeting -> n_receptionist`, the `n_receptionist -> n_booking` LLM-judge edge never fired.

**Root cause:** Switched the assistant's model from `zai-org/GLM-5.3-Flash` (reasoning) to `moonshotai/Kimi-K2.6` (non-reasoning) in setup.ts to fix the 13s latency from debug-story #22. Same model is used for the LLM judge on edges. With GLM-5.3-Flash, the judge prompt "The caller wants to book, schedule, or reschedule an appointment." sent without a YES/NO instruction goes through the model's reasoning and returns YES. With Kimi-K2.6, the same prompt is treated as a user request and Kimi starts *answering helpfully* ("I can help with appointment scheduling. To assist you properly, I'll need some information...") — Telnyx's boolean-judge parser doesn't extract YES from a paragraph, so the edge returns false, and Sarah loops repeating the same phrase.

**Investigation:** Called `/v2/ai/chat/completions` with Kimi-K2.6 and the judge prompt as user message (no system prompt): Kimi sent back a 50-token helpful paragraph, not a YES/NO. Then reverted the model to GLM-5.3-Flash and re-ran setup — judge fires again on the new code path.

**Fix:** Reverted `setup.ts` to `model: "zai-org/GLM-5.3-Flash"`. Removed the `enable_thinking: false` flag (Telnyx silently drops it on assistants — not a top-level field; the API accepts it but doesn't store it). The 13s reasoning latency from debug-story #22 is back, but the judge works.

**Lesson:** The Telnyx `conversation_flow` LLM-judge edges use the assistant's configured model, with no separate judge_model field. Non-reasoning models that don't return terse YES/NO answers fail the judge parser even when they "understand" the question. Reasoning models work because they think through the classification and emit a clean yes in their final content. Switching the assistant model to fix one bug (latency) silently broke judge routing. Test routing edges after any model change. The structurally correct fix for latency is to add a `type:"speak"` entry node before `n_booking` so the caller hears something in 1s while the LLM works in the background — keeps the working reasoning model and hides the gap.

## 28. Real LLM-judge edge mechanics: it's a tool call the model selects, not a separate judge

**Symptom:** Despite fixing every phrasing in `receptionist.txt` (canonical phrases, no paraphrase, lock the wording), conversations kept looping on `n_receptionist` — Sarah repeated "Let me get you to booking. One moment." but `metadata.flow_transitions` showed no `n_receptionist -> n_booking` edge firing. Caller hung up.

**Root cause (from Telnyx Workflows docs https://developers.telnyx.com/docs/inference/ai-assistants/workflows):** My entire mental model of LLM-judge edges was wrong. There is **no separate hidden LLM judge call** on voice — the docs are explicit:

> "On calls, LLM-condition edges are decided by the same model turn that produces the assistant's reply. Telnyx does not run a separate evaluation of the edge prompt after the response. Instead, each LLM-condition edge leaving the active node is offered to the model alongside the assistant's tools as a tool named `transition__<edge_id>`, with the edge's prompt as the tool description. The transition happens only when the model selects that tool; if the model replies without selecting a transition tool, the conversation stays on the current node."

So routing fires by **the model calling the transition tool**, not by an external LLM classifying Sarah's reply text. And the docs warn explicitly:

> "instructions that tell the assistant never to call tools (e.g., 'do not use the transfer tool; the call moves on by itself') can also stop workflow edges from firing: the model obeys the instruction, acknowledges the request, and the workflow silently stays on the node."

My `receptionist.txt` had "and nothing else. Do not paraphrase, do not add any other sentence." after every canonical phrase — that wording functionally told the model to produce a final chat reply and stop, **not to call a tool**. So the transition tool was never selected, the edge never fired, conversation stayed on n_receptionist, Sarah looped her phrase.

The earlier `25bdb007` and `bf83eb83` calls worked when Sarah said canonical action phrasing like "Let me route you to our booking workflow" because the model happened to select the transition tool on those turns — non-deterministic luck, not the canonical wording.

**Fix:** Rewrote `receptionist.txt` per docs' suggested pattern — explicitly direct the model to select the named transition tool:
- "When the caller wants to book, schedule, or reschedule an appointment, call the transition__e_receptionist_to_booking tool to route them to the booking step. Reply briefly that you're moving them to booking, e.g. 'Let me get you to booking. One moment.'"
- Same for `e_receptionist_to_cancellation` and `e_receptionist_to_escalation`.
- Removed all "and nothing else" / "Do not paraphrase, do not add any other sentence" language — those constructively forbade tool calls and stopped routing.
- Removed "Do not promise to check the calendar or look anything up — the booking step will ask for what it needs" — same problem.

**Lesson:** Read the platform docs before debugging prompt-edge issues. The mental model of "LLM judge = separate hidden LLM call evaluating the assistant's reply" was entirely wrong for voice — on voice, the judge edge fires by being selected as a tool named `transition__<edge_id>`. Any instruction that suppresses tool calls (even "and nothing else" or "do not promise to look anything up") suppresses routing. Direct the model explicitly to select the named transition tool. Chat is different — there the post-reply evaluation call returns yes/no verdicts per edge, so the same wording might work on chat but deadlock on voice. Always test routing paths with the assistant's production model. Useful debugging: `trace.ts` shows `metadata.flow_transitions` (now printed at the top of every trace); if a transition is missing, the model never selected the transition tool — check the prompt for any instruction that suppresses tool calls.

## 29. Confirmation never reached the caller — `n_confirmation` is speak, edge fired before model spoke

**Symptom:** Real call `cf71c862-8f42-4e33-af94-8db4eff2012b` (2026-11-17 11:15). Booking succeeded — `book_appointment` returned `{"bookingId":"BK-0001","confirmed":true,"slot":{...time:"14:00",dentist:"Dr. Patel"},...}`. Flow transitions fired correctly: `n_booking → n_confirmation → n_receptionist`. But the caller heard no explicit confirmation — Sarah said "You're all set, Giacomo. Have a great day!" in n_receptionist, and only confirmed the concrete details ("Yes, you're booked for today, November 17th at 2:00 PM with Dr. Patel for a tooth extraction. Anything else?") after the caller asked "The appointment is booked?".

**Root cause:** Two compounding issues from earlier fixes:

1. **My fix in debug-story #22 told `booking.txt` to confirm the booking itself**: "After book_appointment returns success, confirm the booking in ONE short sentence with the date, time, and dentist — e.g. 'Your appointment is booked for today at 1:00 PM with Dr. Lee.' Then stop and wait." But on voice, the `e_booking_to_confirmation` LLM judge edge fires by the model selecting the transition tool — and the platform advances immediately, **before the model gets to speak its confirmation line**. So the booking.txt instruction was dead.

2. **My fix in debug-story #22 reduced `confirmation.txt` to "Is there anything else I can help you with?"** (worried about double-speak). `n_confirmation` was a `type:"speak"` node, so it played that line verbatim. The caller heard "Is there anything else?" but never heard what was just booked — the booking details were nowhere. Then `n_confirmation → n_receptionist` fired immediately (default edge on speak node), Sarah landed in receptionist with the full conversation history (including the tool result with the booked slot) but no specific instruction to confirm — so she said "You're all set."

**Fix:** Converted `n_confirmation` from `type:"speak"` to `type:"prompt"`. New `confirmation.txt` is now an LLM instruction: "You just completed an action. Read the tool result from the conversation history and confirm to the caller in ONE short sentence with the concrete details. For a booking, report date, time, and dentist. For a cancellation, confirm what was cancelled. Then ask 'Is there anything else I can help you with?' and stop. Never invent details that are not in the tool result." `instructions_mode: "append"` so it keeps the global voice rules. The edge `e_confirmation_to_receptionist` had to change from `default` to `llm` (per Telnyx docs, `default` edges are only valid on speak/tool nodes; a prompt node needs an LLM or expression condition). Updated `assemble-workflow.test.ts` counts (3 speak, 4 prompt, 3 default edges, 8 LLM edges). Removed the dead "confirm in one sentence..." line from `booking.txt`.

**Why this fixes it:** Sarah now lands in `n_confirmation` after `book_appointment` succeeds, reads the tool result (still in conversation history), and is forced by the prompt to speak the concrete confirmation (date/time/dentist) before the `e_confirmation_to_receptionist` LLM judge edge has anything to evaluate. Once she asks "Is there anything else?", the judge fires on that cue and routes to n_receptionist.

**Lesson:** Tools/prompt changes and workflow changes are coupled. Fix one side (the booking prompt) without checking the other side (the workflow node type and edge condition) and the fix can silently no-op. The earlier debug-story #22 "model confirms itself" assumption was wrong on voice — the LLM-judge edge transitions the workflow *during* the model's turn, so the model never gets to speak after `book_appointment` returns. Use `type:"prompt"` nodes for any step that needs to read tool results and speak dynamically; `type:"speak"` is only good for fixed compliance lines (greetings, recordings disclosure) where no conversation context is needed. The `default` edge rule is strict: only valid on speak/tool nodes.

## 30. Webhook tools: every `update_booking_draft` returned 400 — Telnyx sends omitted optional params as `null`

**Symptom:** First voice test after moving the booking writes to node-scoped webhook tools. Sarah said "I'm having trouble saving your booking details". The transcript showed four retries of `update_booking_draft {"field":"reason","value":"tooth extraction"}`, each one `{"http_status":400,"http_body":{"error":"Invalid input: expected object, received null"}}`.

**Root cause:** The tool schema has two optional params, `value` (string) and `slot` (object). The LLM's call had no `slot`, but Telnyx put `"slot": null` into the request body. The route validated `slot` with zod `.optional()`, which accepts a missing key but rejects `null`.

**Fix:** `value` and `slot` use `.nullish()`, and the "which one is required" check uses `!= null`. A regression test sends the exact body Telnyx sent.

**How we found it:** The conversation messages API (`GET /ai/conversations/{id}/messages`) returns each tool result with `http_status` and `http_body`, so the 400 and its zod message were right there. Unit tests had passed because they never sent `null`.

**Lesson:** Treat `null` and missing as the same for optional webhook-tool params. Telnyx fills in every declared property.
