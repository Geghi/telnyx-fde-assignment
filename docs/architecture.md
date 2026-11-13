# Architecture — Bright Smile Dental AI Receptionist

AI voice assistant for a dental clinic, built on Telnyx Edge Compute, Voice AI, and MCP.
A smart receptionist that greets callers, identifies intent, books/cancels appointments
via MCP tools, and escalates to a human — all with per-caller state and observability.

## Use case

Caller phones the dental clinic.
The assistant (Sarah) greets with a compliance disclosure, identifies what the caller needs,
and handles booking, cancellation, or FAQ — or escalates to the front desk.
After each task, the caller can ask for something else (loop back to the receptionist).

## Architecture diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      Caller (Phone)                          │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              Telnyx AI Assistant — "Sarah"                    │
│  ┌─────────────────────────────────────────────────────┐    │
│  │            Conversation Workflow                     │    │
│  │  Greeting (speak) → Receptionist (prompt)            │    │
│  │      ├── Booking (prompt) ──→ Confirmation (speak)   │    │
│  │      ├── Cancellation (prompt) ──→ Confirmation      │    │
│  │      └── Escalation (speak) → Transfer (tool node)   │    │
│  │  Confirmation loops back to Receptionist             │    │
│  └─────────────────────────────────────────────────────┘    │
│       │ dynamic vars (once, at call start) │ MCP tool calls   │
└───────┼────────────────────────────────────┼──────────────────┘
        │                                    │
        ▼                                    ▼
┌───────────────────┐                ┌──────────────────────┐
│  Edge Function    │                │  MCP Server          │
│  (TypeScript)     │                │  (TypeScript, edge)  │
│  webhook handler   │                │                      │
│                   │                │  Tools:              │
│  ┌─────┐ ┌──────┐│                │  update_booking_draft│
│  │ KV  │ │Actor ││                │  get_booking_status  │
│  │     │ │      ││                │  check_availability  │
│  └─────┘ └──────┘│                │  book_appointment    │
│                   │                │  cancel_appointment  │
│  structured logs  │                │  get_services        │
│  KV counters      │                │  get_business_info   │
└───────────────────┘                │                      │
                                     │  in-memory data      │
                                     └──────────────────────┘
        All on Telnyx Edge Compute
```

## Documentation findings (from Telnyx docs)

### Webhook timing — fires ONCE per voice call

The dynamic variables webhook (`assistant.initialization` event) fires **at the start
of a voice call**, not on every node transition. The dynamic variables set at
initialization persist for the entire call. Webhook timeout: 1.5s default, up to 10s
via `dynamic_variables_webhook_timeout_ms`.

Payload Telnyx sends:
```json
{
  "data": {
    "event_type": "assistant.initialization",
    "payload": {
      "telnyx_conversation_channel": "phone_call",
      "telnyx_agent_target": "+13128675309",
      "telnyx_end_user_target": "+15551234567",
      "call_control_id": "v3:u5OAKGEPT3Dx8SZSSDRWEMdNH2OripQhO",
      "assistant_id": "assistant_..."
    }
  }
}
```

Expected response:
```json
{
  "dynamic_variables": {
    "caller_name": "John",
    "caller_phone": "+15551234567",
    "online_booking_enabled": "true",
    "clinic_hours": "Mon-Fri 8am-6pm"
  }
}
```

### Workflow nodes — three types

- **Prompt node** — LLM-driven step with its own instructions and scoped tools. Routes via LLM-condition or variable-comparison edges. No default edges.
- **Speak node** — verbatim scripted message, no LLM turn. Must have **exactly one** default edge to the next node.
- **Tool node** — runs a single shared tool deterministically, no LLM turn. Optional `message` field plays a filler before the tool runs. Routes on `telnyx_last_tool_status_code` via variable comparison. Can be terminal (no edges — hangup/transfer).

### KV binding — TypeScript env

`env.MY_KV.get(key)`, `env.MY_KV.put(key, value)`, `env.MY_KV.delete(key)`, `env.MY_KV.list()`.
`get<T>(key, { type: "json" })` for JSON values. `put(key, val, { expirationTtl: seconds })`.
Declared in `func.toml` as `[storage.kv.MY_KV]` with namespace UUID. TypeScript-only env binding.

### Stateful Actor — umbrella manifest

Actors require `telnyx.toml` (not `func.toml`). Class extends `StatefulActor`,
state via `this.ctx.storage.get/put`. Caller routes via `env.BINDING.idFromName(key).method()`.
Single-threaded, per-key isolation, persistent storage.

### System variables for routing

`telnyx_conversation_duration_secs`, `telnyx_last_tool_status_code`,
`telnyx_current_time`, `telnyx_conversation_channel`, etc.

## Components

### 1. Telnyx AI Assistant — "Sarah"

- **Persona:** Sarah, the virtual receptionist at Bright Smile Dental.
- **Voice:** warm, professional, female (Telnyx voice ID — pick from portal).
- **Model:** a conversational LLM (pick from Telnyx-hosted models in the portal).
- **Language:** English.
- **Phone number:** assigned via Telnyx portal.
- **MCP server URL:** configured on the assistant so prompt nodes can call MCP tools.
- **Dynamic variables webhook:** set to the webhook edge function URL.

### 2. Conversation Workflow

A directed graph of 7 nodes connected by conditional edges.

#### Nodes

| #  | Node           | Type   | Purpose                                               | Tools scoped        |
|----|----------------|--------|-------------------------------------------------------|---------------------|
| 1  | Greeting       | speak  | Compliance disclosure + greeting (verbatim)           | —                   |
| 2  | Receptionist   | prompt | Identify intent; answer FAQ; route to next node        | get_business_info, get_services |
| 3  | Booking        | prompt | Multi-turn booking: progressive draft via MCP tools   | update_booking_draft, get_booking_status, check_availability, book_appointment |
| 4  | Cancellation   | prompt | Multi-turn: find by phone → confirm → cancel          | cancel_appointment  |
| 5  | Confirmation   | speak  | Verbatim confirmation (booking, cancellation, callback) | —                |
| 6  | Escalation     | speak  | "Connecting you to our front desk. Please hold."       | —                   |
| 7  | Transfer       | tool   | Call Control API transfer (terminal if success)        | — (shared tool)     |

#### Edges

| From          | To            | Condition type     | Condition                              |
|---------------|---------------|--------------------|----------------------------------------|
| Greeting      | Receptionist  | default            | — (speak node → default required)      |
| Receptionist  | Booking       | LLM condition      | caller wants to book or reschedule     |
| Receptionist  | Cancellation  | LLM condition      | caller wants to cancel                 |
| Receptionist  | Escalation    | LLM condition      | caller requests human or has emergency  |
| Booking       | Confirmation  | LLM condition      | booking or callback request completed  |
| Booking       | Receptionist  | LLM condition      | caller wants to abandon booking         |
| Cancellation  | Confirmation  | LLM condition      | cancellation completed                  |
| Cancellation  | Receptionist  | LLM condition      | caller wants to abandon cancellation    |
| Confirmation  | Receptionist  | default            | "Is there anything else?" (speak → default) |
| Escalation    | Transfer      | default            | — (speak node → default required)      |
| Transfer      | Receptionist  | default            | if transfer fails (fallback)           |

Stretch: Receptionist → Escalation via variable comparison
(`telnyx_conversation_duration_secs >= 300`).

#### How prompt nodes route

A prompt node does NOT have a default edge — the conversation stays on the
node if no LLM/variable edge fires. LLM-condition edges are offered to the model
as `transition__<edge_id>` tools. The model selects one to move, or replies
without one to stay.

#### Loop prevention

Since the webhook fires once, per-call transition tracking is unavailable.
Loop prevention is now purely prompt-based + system variables:
1. **Prompt guardrails** — Receptionist prompt: "don't re-route to a task the caller just abandoned; ask 'is there anything else?'"
2. **System variable** — `telnyx_conversation_duration_secs >= 300` → Escalation (stretch).
3. **LLM edge conditions are explicit** — no vague triggers; edges fire only on clear intent.

#### Node prompts (system prompt outlines)

**Greeting (speak node):**
```
Thank you for calling Bright Smile Dental. This call may be recorded
for quality and training purposes. How can I help you today?
```

**Receptionist (prompt node, instructions_mode: append):**
```
You are Sarah, the virtual receptionist at Bright Smile Dental.
Your job: identify what the caller needs and use the right tool.
If the caller asks about services, hours, or location, use get_business_info
or get_services to answer — don't route to another node for FAQ.
If the caller wants to book or reschedule, say so briefly and the workflow
will route you. If the caller wants to cancel, say so briefly.
If the caller has a dental emergency or asks for a human, say so briefly.
Never make up information — check with tools.
Always tell the caller what you're doing before calling a tool
("Let me check our calendar for you...") and what the result means after.
When a caller returns from an abandoned task and has no new intent,
ask "Is there anything else I can help you with?" — don't re-route them.
```

**Booking (prompt node, instructions_mode: append):**
```
You are Sarah, helping the caller book a dental appointment.
Use the draft tools to save each piece of information as you collect it.
Every save returns a status telling you the next step — follow it.
Call get_booking_status first to see if a draft already exists.
Collect in order: reason → preferred date → slot → name.
If no preferred date, search from today.
Call check_availability once you have a date, present the first slot.
When the caller confirms a slot, save it and ask for name.
Call book_appointment only when status says all fields are filled.
The caller can correct any field — call update_booking_draft again.
If online_booking_enabled is false, explain the request is noted
and staff will confirm as soon as possible.
Always tell the caller what you're doing before calling a tool.
Never make up slot times. Follow the status from each tool call.
```

**Cancellation (prompt node, instructions_mode: append):**
```
You are Sarah, helping the caller cancel or reschedule an appointment.
Steps: confirm the caller's phone number (from caller_phone variable),
call cancel_appointment, confirm what was cancelled.
If rescheduling, guide them to book a new appointment.
Be concise and confirm before cancelling.
Always tell the caller what you're doing before calling a tool.
```

**Confirmation (speak node):**
```
For booking: "Your appointment is confirmed for {{date}} at {{time}} with
Dr. {{dentist}}. Please arrive 15 minutes early. We look forward to seeing you."
For callback: "Your request has been noted. Our staff will confirm your
appointment as soon as possible. Thank you for calling Bright Smile Dental."
For cancellation: "Your appointment on {{date}} has been cancelled.
Is there anything else I can help you with?"
```

**Escalation (speak node):**
```
I'm connecting you with our front desk team. Please hold.
```

**Transfer (tool node):**
```
message: "One moment while I connect you." (optional — already spoken by Escalation node)
shared_tool_id: <Transfer tool — Call Control API transfer to front desk number>
```

### 3. Webhook Edge Function (TypeScript)

Deployed on Telnyx Edge Compute via `telnyx-edge ship`.
URL: `https://webhook-<org>.telnyxcompute.com`

**Responsibilities:**
- Receive ONE webhook call at the start of each voice call (`assistant.initialization`).
- Read the `CallSession` Stateful Actor for returning-caller personalization.
- Read KV (feature flags, cached clinic hours, counters).
- Increment KV counters (calls per caller — observability signal).
- Return dynamic variables to the workflow (persists for the whole call).
- Structured JSON log on every webhook call.
- Expose a `/metrics` endpoint to read KV counters for observability.

**Manifest:** `telnyx.toml` (umbrella — required for actors).

**Bindings:**
- `[storage.kv.CLINIC_KV]` — `env.CLINIC_KV` (KV namespace)
- `[[actors]]` binding `CALL_SESSION` → `CallSession` class
- `[telnyx]` binding — pre-authenticated Telnyx SDK (for Call Control API)

**Webhook payload** (from Telnyx):
```json
{
  "data": {
    "event_type": "assistant.initialization",
    "payload": {
      "telnyx_end_user_target": "+15551234567",
      "call_control_id": "v3:...",
      "assistant_id": "assistant_..."
    }
  }
}
```

**Response** (dynamic variables, set once for the call):
```json
{
  "dynamic_variables": {
    "caller_name": "John",
    "caller_phone": "+15551234567",
    "online_booking_enabled": "true",
    "clinic_hours": "Mon-Fri 8am-6pm, Sat 9am-2pm"
  }
}
```

### 4. MCP Server (TypeScript, edge function)

Deployed on Telnyx Edge Compute via `telnyx-edge ship`.
URL: `https://mcp-server-<org>.telnyxcompute.com`

**Language:** TypeScript using `@modelcontextprotocol/sdk`.

**Transport:** MCP over HTTP (Streamable HTTP transport).

**Tools (7):**

| Tool                   | Args                              | Returns                              | Used in        |
|------------------------|-----------------------------------|--------------------------------------|----------------|
| `update_booking_draft` | `field`, `value`                  | `{ draft, status: { next_step, missing_fields } }` | Booking |
| `get_booking_status`   | —                                 | `{ draft, status }`                  | Booking        |
| `check_availability`    | `date_from`, `date_to?`           | List of available slots              | Booking        |
| `book_appointment`     | (reads draft by caller_phone)     | `{ booking_id, date, time, dentist, confirmed }` | Booking |
| `cancel_appointment`   | `phone`, `booking_id?`            | `{ cancelled: true, date }`          | Cancellation   |
| `get_services`         | —                                 | Services with prices/descriptions    | Receptionist   |
| `get_business_info`    | —                                 | Hours, location, policies            | Receptionist   |

**Booking draft status flow:**
```
update_booking_draft("reason", value)
  → status: { next_step: "ask_preferred_date", missing: ["preferred_date", "slot", "name"] }
update_booking_draft("preferred_date", value)
  → status: { next_step: "search_slots", missing: ["slot", "name"] }
  (LLM calls check_availability here)
update_booking_draft("slot", value)
  → status: { next_step: "ask_name", missing: ["name"] }
update_booking_draft("name", value)
  → status: { next_step: "book", missing: [] }
  (LLM calls book_appointment here)
```

The draft is keyed by `caller_phone` in the MCP server's in-memory store.
The caller can correct any field at any time — `update_booking_draft` overwrites.
`get_booking_status` retrieves the current draft and status.

**Data store:** in-memory Map keyed by caller phone (resets on cold start).

### 5. KV (Key-Value Store)

| Key                      | Value              | Purpose                          |
|--------------------------|--------------------|----------------------------------|
| `online_booking_enabled` | `true`/`false`     | Feature flag: book now or note as callback |
| `clinic_hours`           | JSON hours string  | Cached clinic hours for dynamic vars |
| `webhook_calls:{caller}` | integer            | Observability: call count per caller |
| `webhook_errors`         | integer            | Observability: total error count |

### 6. Stateful Actor — CallSession

One actor per caller, keyed by `caller:+{phone}`. Read once at call start; persisted across calls.

**State fields:**

| Field             | Type   | Purpose                                     |
|-------------------|--------|---------------------------------------------|
| `callerName`      | string | Name if previously provided in a booking     |
| `lastBookingId`   | string | Last booking ID (for returning callers)     |
| `totalCalls`      | number | Total calls from this number (returning caller) |

**Read-modify-write:** the webhook reads the session, increments `totalCalls`,
sets `callerName` if known, and returns dynamic variables. Persists across calls —
if the same person calls twice, `totalCalls` is 2 and the greeting says "Welcome back."

### 7. Observability

**Structured logs (webhook):**
```json
{
  "timestamp": "ISO-8601",
  "caller": "+15551234567",
  "event": "assistant.initialization",
  "outcome": "ok",
  "latency_ms": 42,
  "returning_caller": true,
  "actor_key": "caller:+15551234567"
}
```

**Signal beyond logs:** KV counters (calls per caller, errors — readable via `/metrics` endpoint).

**How you'd know it broke within 1 minute:**
1. KV `webhook_errors` spiking → the webhook is failing.
2. No webhook calls arriving → the assistant's webhook URL is misconfigured.
3. Telnyx portal call logs → conversation side: node transitions, tool calls, transcripts.

**Filler messages on external calls:** the LLM is prompted to always announce what it's doing
before calling a tool ("Let me check our calendar...") and what the result means after.
For tool nodes (like Transfer), the optional `message` field serves the same purpose.

## Folder structure

```
edge-functions/
  webhook/                     # TypeScript — dynamic webhook variables + KV + Actor
    src/
      index.ts                 # HTTP handler — webhook + /metrics endpoints
      actor.ts                 # CallSession StatefulActor class
      variables.ts             # dynamic variable assembly
      types.ts
    tests/
    telnyx.toml                # umbrella manifest (actors + KV + telnyx bindings)
    package.json
  mcp-server/                  # TypeScript — MCP server with scheduling tools
    src/
      index.ts                 # MCP HTTP transport server
      tools.ts                  # tool implementations
      store.ts                  # in-memory appointment + draft store
    tests/
      func.toml                # standard function manifest (no actors needed)
    package.json
assistant-voice-agent/         # assistant configuration
  workflow.json                # conversation workflow definition (API payload)
  prompts/                     # system prompt per node
    greeting.txt
    receptionist.txt
    booking.txt
    cancellation.txt
    confirmation.txt
    escalation.txt
  setup.ts                     # script to create assistant + assign phone via API
docs/
  architecture.md              # this file
  adr/                         # architecture decision records
  prd/                         # product requirement docs
  agents/                      # agent-facing docs
```

## Deployment

| Component          | Platform             | Deploy command                    | Manifest        |
|--------------------|-----------------------|-----------------------------------|-----------------|
| Webhook            | Telnyx Edge Compute  | `telnyx-edge ship` (from webhook/) | `telnyx.toml` (actors) |
| MCP server         | Telnyx Edge Compute  | `telnyx-edge ship` (from mcp-server/) | `func.toml` |
| Assistant + workflow | Telnyx portal/API   | `assistant-voice-agent/setup.ts` | —              |
| Phone number       | Telnyx portal        | assign to assistant              | —              |
| KV namespace       | Telnyx CLI           | `telnyx-edge storage kv create`  | UUID in toml    |

All on Telnyx. No external hosting needed.

## Build order

1. **MCP server** (TS edge function) — scaffold, implement 7 tools + draft store, test locally, ship.
2. **Webhook edge function** (TS) — scaffold with `--actor`, implement Actor + KV + dynamic vars, ship.
3. **KV namespace** — create via CLI, put `online_booking_enabled`, `clinic_hours`.
4. **Assistant + workflow** — create assistant in portal, set MCP URL + webhook URL, build the 7-node workflow, assign phone number.
5. **Test end-to-end** — call the number, walk through each workflow path.
6. **Observability** — verify logs, KV counters, `/metrics` endpoint, write "what broke" story.
7. **Documentation** — README with setup, architecture, observability story, demo script.
