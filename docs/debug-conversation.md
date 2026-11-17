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

3. **Trace the message timeline.** `npm run trace <conversation_id>` (or `npm run trace` alone for the newest conversation) prints the channel, the workflow node transitions, and the messages (up to 100) with tool calls and tool results inline.
   If the conversation has more than 100 messages, the earliest ones are cut off.
   Find the turn where the assistant went off the rails: missing tool call, wrong args, ignored result, hedged when it should have concluded, or spoke past a node boundary.

4. **Check the node.** Match that turn to a workflow node in `assistant-voice-agent/workflow.json`. Read that node's prompt in `assistant-voice-agent/prompts/`. Most bugs are either a prompt instruction the model isn't following, or an edge condition that didn't fire. **Check the prompt and the edge condition together** — when a prompt tells the model to stay silent and an LLM-judge edge waits for the model to *express* something, the two contradict and the edge never fires (see debug-story #22).

5. **Check actor state (if state-related).** `telnyx-edge actors logs BookingActor` and `telnyx-edge actors instances BookingActor` — see whether the draft/booking actually persisted across the conversation's tool calls. The actor is keyed by `caller:<caller_phone>`, so if state vanished, check that `caller_phone` arrived in the tool request (MCP log line `tool_call`) and that the actor was shipped (debug-story #21).

6. **Check the webhook.** For dynamic variable issues (empty `{{today_date}}`, wrong hours) visit the webhook: `edge-functions/webhook/` and the `CLINIC_KV` namespace. Chat mode does **not** fire the webhook — only telephony does (debug-story #5).

7. **Fix and re-deploy.** Prompt-only fix → `npm run setup`. Code change in an edge function → `telnyx-edge ship` from that function's directory.

The trace CLI is `assistant-voice-agent/trace.ts`. Full bug log with patterns: `docs/debug-story.md`.

