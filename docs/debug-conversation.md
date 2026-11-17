# Debug a conversation

When a call or chat behaves wrong (wrong tool, lost state, double-confirmation, hallucinated date):

1. **Find the conversation id** (if you don't already have one). List recent conversations straight off the Telnyx API — chat.ts only returns an id when *you* start the conversation, it can't look up the last real call.
   ```sh
   set -a; . ./.env.local; set +a
   curl -sS "https://api.telnyx.com/v2/ai/conversations?page%5Bsize%5D=10" \
     -H "Authorization: Bearer $TELNYX_API_KEY" -o /tmp/convs.json
   node -e 'const d=require("/tmp/convs.json"); for (const c of d.data) console.log(c.created_at, c.id, "|", c.name, "| transitions:", (c.metadata.flow_transitions||[]).length)'
   ```
   `%5B`/`%5D` are URL-encoded `[`/`]` — bare brackets break curl. Pick the newest by `created_at`.
   **Read `metadata.flow_transitions` first.** That array is the timeline of which workflow nodes fired and when. If the transition you expected (e.g. `n_booking -> n_confirmation`) is missing or fired late, the bug is a transition miss — skip straight to step 3 and check the edge condition.

2. **Reproduce or open.** To start fresh, `npm run chat <assistant_id>` in `assistant-voice-agent/` (prints a conversation id). To debug the call that already went wrong, use the id from step 1 and go straight to step 3.

3. **Trace the message timeline.** `npm run trace <conversation_id>` prints the conversation with tool calls and tool results inline.
   **Caveat — pagination:**
   `trace.ts:43` calls `/ai/conversations/:id/messages` with **no `page[size]`**, so the API defaults to 20 messages. Real calls can be longer (the 2026-11-17 trace had 35). If the printed count looks low or the opening greeting/draft steps are missing, fetch directly:
   ```sh
   set -a; . ./.env.local; set +a
   curl -sS "https://api.telnyx.com/v2/ai/conversations/<ID>/messages?page%5Bsize%5D=100" \
     -H "Authorization: Bearer $TELNYX_API_KEY" -o /tmp/msgs.json
   node -e 'const d=require("/tmp/msgs.json"); const m=(d.data||[]).slice().reverse(); for (const x of m){const t=(x.sent_at||x.created_at||"").slice(11,19); const r=(x.role||"").padEnd(9); let l=`[${t}] ${r}${(x.text||"").slice(0,200)}`; if(x.tool_calls)for(const tc of x.tool_calls){const a=JSON.parse(tc.function.arguments);l+=`\n      -> ${tc.function.name}(${Object.entries(a).map(([k,v])=>k+"="+(typeof v==="object"?JSON.stringify(v):v)).join(", ")})`;} if(x.role==="tool")l+=`\n      <- ${(x.text||"").slice(0,260)}`; console.log(l);}'
   ```
   `meta.total_results` is the real count — trust it over a default-paged reply.
   Find the turn where the assistant went off the rails: missing tool call, wrong args, ignored result, hedged when it should have concluded, or spoke past a node boundary.

4. **Check the node.** Match that turn to a workflow node in `assistant-voice-agent/workflow.json`. Read that node's prompt in `assistant-voice-agent/prompts/`. Most bugs are either a prompt instruction the model isn't following, or an edge condition that didn't fire. **Check the prompt and the edge condition together** — when a prompt tells the model to stay silent and an LLM-judge edge waits for the model to *express* something, the two contradict and the edge never fires (see Last debug run, below).

5. **Check actor state (if state-related).** `telnyx-edge actors logs BookingActor` and `telnyx-edge actors instances BookingActor` — see whether the draft/booking actually persisted across the conversation's tool calls. If state vanished, the `_meta.telnyx_conversation_id` wasn't threaded or the actor wasn't shipped (see debug-story #21).

6. **Check the webhook.** For dynamic variable issues (empty `{{today_date}}`, wrong hours) visit the webhook: `edge-functions/webhook/` and the `CLINIC_KV` namespace. Chat mode does **not** fire the webhook — only telephony does (debug-story #5).

7. **Fix and re-deploy.** Prompt-only fix → `npm run setup`. Code change in an edge function → `telnyx-edge ship` from that function's directory.

The trace CLI is `assistant-voice-agent/trace.ts`. Full bug log with patterns: `docs/debug-story.md`.

---

## Last debug run — 2026-11-17

**Conversation:** `25bdb007-f1ce-40cf-ae88-d2427cc7fe3a` (telephony, assistant `assistant-c7d08f46-…`). Caller booked a tooth extraction with Dr. Lee at 1 PM today, then the call stalled.

### Procedure followed
1. Listed recent conversations via `GET /ai/conversations`, picked newest (`25bdb007…`).
2. Read `metadata.flow_transitions`:
   ```
   09:44:45 n_greeting -> n_receptionist
   09:45:00 n_receptionist -> n_booking
   09:46:17 n_booking -> n_confirmation   ← fired 1 second AFTER the caller hung up
   ```
   The `n_booking -> n_confirmation` edge fired late. That already pointed the bug at the transition, not at any individual tool call.
3. `npm run trace` printed only 20/35 messages (default page size — see step 3 caveat). Re-fetched with `page[size]=100` and reversed the array to get chronology. The opening greeting + 4 `update_booking_draft` calls were the missing 15.
4. Walked the timeline; the dead turn was right after `book_appointment` succeeded.

### Bug found: prompt-edge deadlock on `n_booking -> n_confirmation`
- `prompts/booking.txt:20` — *"After book_appointment returns success, DO NOT confirm or summarize… Just stay silent, or say 'give me one moment' if you must speak. Never say 'your appointment is confirmed' or 'is there anything else'."*
- `workflow.json:86-90` edge `e_booking_to_confirmation` — `{"type":"llm","prompt":"The booking or callback request has been completed."}`

The model obeyed the prompt and hedged ("One moment while I finalize that for you."). The LLM-judge edge needs the model to *express* completion to fire, so it never did — until the caller got confused and asked "So what happened?", which forced the model to break its prompt and emit a real confirmation. By then the caller had already said "Bye" and the static `n_confirmation` speak played one second later, never reaching anyone.

### Secondary finding: `confirmation.txt` is generic
`prompts/confirmation.txt` is one line — *"Your request has been completed. Thank you for calling Bright Smile Dental. Is there anything else I can help you with?"* — it never mentions the date/time/dentist the caller just booked, so even when the transition fires on time, the caller hears nothing concrete about their appointment.

### Tooling bug: `trace.ts` truncates at 20 messages
`trace.ts:43` omits `page[size]`; Telnyx defaults to 20. The CLI reported "20 messages" for a 35-message call and showed them reverse-chronologically, hiding the booking-draft steps. Worth a one-line fix (`?page[size]=200` or loop `total_pages`).

### Fix options on the table (not yet committed)
1. **Tool-result edge.** Change `e_booking_to_confirmation` to fire on `book_appointment` returning `confirmed:true` instead of an LLM judge. Correct repair; needs verifying the Telnyx edge schema supports tool-result conditions.
2. **Loosen the prompt.** Let the model give a one-line confirmation ("Your appointment is booked for [date/time/dentist].") and have `e_booking_to_confirmation` fire on that; possibly drop the static `n_confirmation` speak entirely.
3. **Enrich `confirmation.txt`** with the booked slot. Needs the actor draft wired into the speak node as variables.

### Fix shipped — 2026-11-17
Path A (deterministic `type:"tool"` node for `book_appointment`) is **not available**: Telnyx `/ai/tools` accepts only `transfer`, `webhook`, `hangup` — no `mcp` type, so an MCP-server-backed tool can't sit in a tool node.
Path B applied, minimal: edited `prompts/booking.txt:20` to require the model to confirm the booking itself in one short sentence with date/time/dentist (e.g. "Your appointment is booked for today at 1:00 PM with Dr. Lee."). The LLM-judge edge `e_booking_to_confirmation` ("The booking has been completed.") now fires on that cue. `n_confirmation` then plays "anything else?" as designed. Also fixed `trace.ts:43` to pass `?page[size]=200` so the CLI no longer truncates at 20 messages.
Shipped via `npm run setup`. Tests + typecheck green. To verify: place a real call or run `npm run chat <assistant_id>`, then `npm run trace <new_id>` — confirm `n_booking -> n_confirmation` fires in the same turn as `book_appointment`, no long silence.
