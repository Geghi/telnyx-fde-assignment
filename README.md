# Bright Smile Dental — AI Voice Receptionist

Sarah answers the phone for a dental clinic: she answers questions about hours, services and prices, books, looks up and cancels appointments, and hands the caller to the front desk on request or in an emergency. When online booking is switched off, she takes a call-back request instead of booking.

Everything runs on Telnyx: AI Assistant with a Conversation Workflow, two Edge Functions, KV and Stateful Actors.

## Try it

| What | Where |
|---|---|
| Phone number | Not purchased yet. Test from the Telnyx Portal: AI Assistants → "Sarah — Bright Smile Dental" → Test (voice or chat). `npm run buy-number` + `npm run setup` buys one and binds it to the assistant. |
| Dynamic-variables webhook | https://webhook-03381a02-a.telnyxcompute.com |
| Webhook counters | https://webhook-03381a02-a.telnyxcompute.com/metrics |
| MCP server | https://mcp-server-5d976a49-d.telnyxcompute.com |

Things to say:

- "What are your hours?" / "How much is a cleaning?" (MCP read tools)
- "I'd like to book a cleaning for Thursday." (booking flow)
- "What appointment do I have?" then "Cancel it." (lookup and cancel)
- "I need to talk to a person." (escalation)

## Architecture

```
Caller ──► Telnyx AI Assistant (Conversation Workflow)
             │ call start               │ read tools (MCP)        │ write tools (webhook tools)
             ▼                          ▼                         ▼
        webhook (Edge Function)     mcp-server (Edge Function) ──────────┐
          ├─ CallSession actor        ├─ get_business_info / get_services / check_availability
          │  (per caller)             ├─ POST /tools/<name> ──► BookingActor (per caller)
          └─ KV: flag, hours,         ├─ GET /callbacks (staff, bearer token)
             counters                 └─ KV: clinic config, online_booking_enabled
```

Diagrams (system, booking call sequence, workflow graph, state): [docs/diagrams/architecture.html](docs/diagrams/architecture.html). Platform terms: [docs/telnyx-glossary.md](docs/telnyx-glossary.md).

### Conversation Workflow

| Node | Type | Job | Tools |
|---|---|---|---|
| Greeting | speak | Verbatim greeting and disclosure | — |
| Receptionist | prompt | Answer FAQ, look up an appointment, route | MCP reads + `get_appointment` |
| Booking | prompt | Collect reason, date, slot, name; book | `update_booking_draft`, `get_booking_status`, `book_appointment` |
| Booking request | prompt | Same draft, saved as a call-back request | `update_booking_draft`, `get_booking_status`, `save_booking_request` |
| Callback confirmation | speak | Verbatim call-back promise | — |
| Cancellation | prompt | Find the appointment, confirm, cancel | `get_appointment`, `cancel_appointment` |
| Confirmation | prompt | Read the tool result back with the real date, time and dentist | — |
| Escalation | speak | Verbatim "connecting you to the front desk" | — |
| Transfer | tool | Dial-transfer to the front desk | transfer tool |

Edges:

- **LLM conditions** for intent: receptionist → booking / cancellation / escalation, and "the caller wants to do something else" back to the receptionist from every task node.
- **Variable comparison** for the feature flag: Booking → Booking request when `online_booking_enabled == "false"`. Deterministic, because a flag must never depend on the model's judgment.
- **Default edges** after speak nodes, where nothing needs deciding.

Task nodes use `tools_mode: "append"`, so the MCP read tools stay available and each node adds only the write tools it needs. Confirmation gets no extra tools. A node with fewer tools calls the right one more reliably, and Receptionist cannot book by accident.

### Dynamic Webhook Variables

On call start the assistant calls the `webhook` function, which returns:

| Variable | Source | Used for |
|---|---|---|
| `caller_name` | CallSession actor | Known caller's name. Not used for now: no prompt reads it and nothing saves a name yet (see Known limits) |
| `caller_phone` | Telnyx payload | Identifying the caller |
| `online_booking_enabled` | KV flag | **Routing**: book directly or take a call-back request |
| `clinic_hours` | KV `business_info` | Same hours the MCP server reports |
| `today_date`, `weekday`, `week_snapshot`, `current_month`, `next_month` | computed | Resolving "next Tuesday" to a real date |

### Which primitive holds which state

| State | Primitive | Why |
|---|---|---|
| Caller session (name, last booking, call count) | **CallSession actor**, one per caller | Read-modify-write on every call; the actor's single-threaded execution makes it safe without a lock |
| Booking draft and booking | **BookingActor**, one per caller | Several tool calls per turn update the same draft; the actor serializes them |
| Call-back request queue | **BookingActor** `clinic:callbacks` | One shared list that staff read and the assistant appends to |
| Clinic config, `online_booking_enabled` | **KV** | Read-mostly, shared by both functions, changed without a redeploy |
| Counters (`webhook_calls`, `webhook_errors`) | **KV** | Cheap signal. ⚠️ The increment is not atomic, so concurrent calls can lose counts. Fine for a demo; at real volume, move to an actor or the platform metrics |
| Calendar snapshot, variable assembly | plain function logic | Stateless |

### Turning online booking off without a redeploy

```bash
telnyx-edge storage kv key put 82be9f48-ca78-43f7-a50a-c0109d536465 online_booking_enabled false   # call-back requests
telnyx-edge storage kv key put 82be9f48-ca78-43f7-a50a-c0109d536465 online_booking_enabled true    # normal booking
./scripts/list-callbacks.sh   # what the front desk has to call back
```

The next call picks up the change. A call already in progress keeps the value it got at the start.

## Observability

### What is instrumented

**Structured logs: one JSON line per request.**

Webhook (`edge-functions/webhook/src/handlers/webhook.ts`):

```json
{"timestamp":"…","event":"assistant.initialization","caller":"+1555…","call_control_id":"v3:…","actor_key":"caller:+1555…","outcome":"ok","latency_ms":42,"returning_caller":true}
```

Failures go to `console.error` with `outcome: "invalid_payload"` or `outcome: "error"` and the error message.

MCP server (`edge-functions/mcp-server/src/index.ts`):

```json
{"event":"tool_call","tool":"book_appointment","caller":"+1555…","status":200,"latency_ms":31}
{"event":"mcp_request","method":"tools/call","tool":"check_availability","status":200,"latency_ms":12}
```

Errors are logged as `tool_error` / `mcp_error`.

**Signals beyond logs**

- `latency_ms` on every line.
- KV counters `webhook_calls`, `webhook_calls/<phone>` and `webhook_errors`; `GET /metrics` returns the totals.
- Platform side: `telnyx-edge metrics <function>` and `telnyx-edge logs <function> --type invocations` give request counts and status codes, even for paths that log nothing.

**Tracing one call.** `caller` appears in the webhook line and in every tool-route line, so you can follow one call across Function → Actor → tool routes. For the conversation side, `npm run trace [conversation_id]` (in `assistant-voice-agent/`) prints which workflow nodes fired, in order, and every tool call with its HTTP status and body. Without an id it traces the newest conversation, so right after a Portal test you just run `npm run trace`.

### How I'd know it broke, within a minute

| Symptom | Where it shows | Look at first |
|---|---|---|
| Webhook failing | `webhook_errors` rising in `/metrics`; `outcome:"error"` lines | `telnyx-edge logs webhook --tail`: the error message names the actor or KV call |
| Webhook not called at all | `webhook_calls` flat while calls come in | Assistant config: `dynamic_variables_webhook_url` |
| Booking or cancel failing | `tool_call` lines with `status` ≥ 400, or `tool_error` | `npm run trace <conversation_id>`: the tool result's `http_body` holds the validation error |
| Conversation stuck in a node | Caller hears silence or repeats; `flow_transitions` missing the expected step | `npm run trace`: compare the node sequence against the edge condition |
| Slow answers | `latency_ms` climbing | Which hop: webhook line vs. `tool_call` / `mcp_request` lines |

### A bug I found with this: the booking that was never confirmed

1. **Symptom.** On a real test call (conversation `25bdb007-f1ce-40cf-ae88-d2427cc7fe3a`), the booking succeeded, but Sarah said "One moment while I finalize that for you." and went silent for 12 seconds. The caller asked "So what happened?", got the details, said "Bye" and hung up.
2. **Evidence.** The trace's `flow_transitions` showed the step that should follow a booking firing *after* the caller had gone:
   ```
   Flow transitions:
     2026-11-17T09:44:45Z n_greeting -> n_receptionist (expression, edge e_greeting_to_receptionist)
     2026-11-17T09:45:00Z n_receptionist -> n_booking (llm, edge e_receptionist_to_booking)
     2026-11-17T09:46:17Z n_booking -> n_confirmation (llm, edge e_booking_to_confirmation)   <- after "Bye"

   [09:45:44] assistant → TOOL CALL: book_appointment
   [09:45:44] tool      [{"bookingId": "BK-0001", ... "confirmed": true}]
   [09:45:44] assistant One moment while I finalize that for you.
   [09:45:56] system    [long silence]
   [09:45:56] assistant Thank you for your patience, Giacomo.
   [09:46:08] user      So what happened?
   [09:46:09] assistant Your appointment is booked for today at 1:00 PM with Dr. Lee ...
   [09:46:16] user      No. No. Thank you. Bye.
   ```
   So the problem was the transition, not a tool call: `book_appointment` had returned `confirmed: true` on time.
3. **Cause.** The Booking prompt told the model *not* to confirm ("stay silent, the next node will"), while the edge out of Booking is an LLM condition that waits for the model to express "the booking has been completed". The prompt and the edge contradicted each other, so the edge never fired.
4. **First fix, and what it taught.** Letting the Booking node confirm by itself didn't work either (call `cf71c862-8f42-4e33-af94-8db4eff2012b`): on voice the platform moves to the next node as soon as the model picks the transition, before it speaks. And the Confirmation node was a *speak* node, so it could only say a fixed line, with no booking details.
5. **Final fix.** Booking stops after `book_appointment`; Confirmation became a *prompt* node that reads the tool result and says the real date, time and dentist; its exit edge is an LLM condition on "the caller has been asked if there's anything else". Rule learned: check a node's prompt and its exit edge together, and use speak nodes only for fixed text.

Replay it: `cd assistant-voice-agent && npm run trace 25bdb007-f1ce-40cf-ae88-d2427cc7fe3a`.

A smaller one, found the same way: after moving the writes to webhook tools, every `update_booking_draft` failed. The trace showed each tool result as `{"http_status":400,"http_body":{"error":"Invalid input: expected object, received null"}}`: Telnyx sends omitted optional parameters as `null`, and the route only accepted a missing key. Fixed with `.nullish()` and a regression test using the exact body Telnyx sent.

More bugs and how each was found: [docs/debug-story.md](docs/debug-story.md). Conversation debugging procedure: [docs/debug-conversation.md](docs/debug-conversation.md).

## Setup

Requirements: Node 20+, `telnyx-edge` CLI (`telnyx-edge auth login`), a Telnyx API key.

```bash
cp .env.example .env.local        # fill TELNYX_API_KEY, FRONT_DESK_NUMBER, STAFF_TOKEN

# 1. KV namespace (once), then put its id in both telnyx.toml files
telnyx-edge storage kv create --name clinic-kv

# 2. Edge Functions
cd edge-functions/webhook    && npm install && telnyx-edge ship
cd ../mcp-server             && npm install && telnyx-edge ship
telnyx-edge secrets add STAFF_TOKEN <value>    # from mcp-server/

# 3. Assistant, workflow, tools, phone number
cd ../../assistant-voice-agent && npm install
npm run buy-number    # optional: buys a number and writes ASSISTANT_PHONE_NUMBER
npm run setup         # registers MCP server and tools, creates or updates the assistant
```

`setup.ts` finds existing tools by name and does not update them. After changing a tool definition, `MCP_SERVER_URL` or `FRONT_DESK_NUMBER`, delete that tool in the portal (AI Tools) and run setup again.

### Tests

```bash
npm test            # in each of edge-functions/webhook, edge-functions/mcp-server, assistant-voice-agent
npx tsc --noEmit
npm run eval        # assistant-voice-agent: scripted conversations scored by an LLM judge
```

## Built with Telnyx Inference (OpenCode)

The `@telnyx/opencode` plugin is configured in [.opencode/opencode.json](.opencode/opencode.json):

```json
{ "$schema": "https://opencode.ai/config.json", "plugin": ["@telnyx/opencode"] }
```

Models used for coding:

- **`zai-org/GLM-5.2`**: most of the work. Fast and good enough for focused, well-specified changes (a handler, a test, a prompt edit) when the task names the files and the expected result.
- **`moonshotai/Kimi-K2.6`**: tried briefly for coding; the results were weaker, so I went back to GLM. `TODO: one concrete example of what went wrong`

What I learned about Telnyx Inference along the way:

- As an **eval judge**, `GLM-5.3-Flash` returned empty answers: it is a reasoning model, and the reasoning tokens used the whole `max_tokens` budget even with `enable_thinking: false`. `Kimi-K2.6` (non-reasoning) returns clean JSON, so it is the judge (debug-story #16).
- `TODO: anything else that worked well or badly (speed, tool calling, context length, cost)`

The assistant itself runs on `zai-org/GLM-5.3-Flash`; the eval judge defaults to `moonshotai/Kimi-K2.6`.

## Known limits

- **Double booking.** `check_availability` is an MCP read with no caller, so it filters only the fixed slot grid, not other callers' bookings, and two callers can book the same slot. Fix: one clinic-wide calendar actor that reserves slots atomically.
- **Tool routes are unauthenticated.** `POST /tools/*` accepts any request, so anyone who knows a caller's number could read or cancel that caller's appointment. Fix: verify the `telnyx-signature-ed25519` and `telnyx-timestamp` headers Telnyx sends on every request.
- **Returning-caller data is never filled.** Nothing calls `updateCallerName` or `setLastBooking`, so `caller_name` is always `""`. Bookings live in BookingActor and never reach CallSession.
- **Webhook latency.** 2 actor calls and 6 KV operations (2 reads, then 2 read-increment-write counters) run one after another. That's well within our 8 s timeout, but would be tight against Telnyx's 1.5 s default; running the KV reads in parallel would cut it.
- **Front-desk transfer** dials a placeholder number unless `FRONT_DESK_NUMBER` is set to a real phone.
- **KV counters** can lose increments under concurrent calls (see the state table above).
- **Tracing** correlates calls across functions by `caller`, not by a shared request id.
