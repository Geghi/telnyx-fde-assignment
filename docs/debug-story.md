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
