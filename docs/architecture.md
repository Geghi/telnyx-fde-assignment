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
│  │      ├── Booking (prompt) ──→ Confirmation (speak)  │    │
│  │      ├── Cancellation (prompt) ──→ Confirmation      │    │
│  │      └── Escalation (speak)                          │    │
│  │  Confirmation loops back to Receptionist             │    │
│  └─────────────────────────────────────────────────────┘    │
│       │ dynamic vars        │ MCP tool calls                 │
└───────┼──────────────────────┼────────────────────────────────┘
        │                      │
        ▼                      ▼
┌───────────────────┐  ┌──────────────────────┐
│  Edge Function    │  │  MCP Server          │
│  (TypeScript)     │  │  (Python, edge)      │
│  webhook handler   │  │                      │
│                   │  │  Tools:              │
│  ┌─────┐ ┌──────┐│  │  check_availability  │
│  │ KV  │ │Actor ││  │  book_appointment    │
│  │     │ │      ││  │  cancel_appointment │
│  └─────┘ └──────┘│  │  get_services       │
│                   │  │  get_business_info  │
│  structured logs  │  │                      │
│  KV counters      │  │  in-memory data      │
└───────────────────┘  └──────────────────────┘
        All on Telnyx Edge Compute
```

## Components

### 1. Telnyx AI Assistant — "Sarah"

- **Persona:** Sarah, the virtual receptionist at Bright Smile Dental.
- **Voice:** warm, professional, female (Telnyx voice ID — pick from portal).
- **Model:** a conversational LLM (pick from Telnyx-hosted models in the portal).
- **Language:** English.
- **Phone number:** assigned via Telnyx portal.
- **MCP integration:** the MCP server URL is configured on the assistant so
  prompt nodes can call MCP tools.

### 2. Conversation Workflow

A directed graph of 6 nodes connected by conditional edges.

#### Nodes

| #  | Node           | Type   | Purpose                                               | Tools scoped        |
|----|----------------|--------|-------------------------------------------------------|---------------------|
| 1  | Greeting       | speak  | Compliance disclosure + greeting (verbatim)           | —                   |
| 2  | Receptionist   | prompt | Identify intent; answer FAQ; route to next node        | get_business_info, get_services |
| 3  | Booking        | prompt | Multi-turn booking: reason → date → slot → name → book | check_availability, book_appointment |
| 4  | Cancellation   | prompt | Multi-turn: find by phone → confirm → cancel          | cancel_appointment  |
| 5  | Confirmation   | speak  | Verbatim confirmation (booking, cancellation, callback) | —                |
| 6  | Escalation     | speak  | "Connecting you to our front desk. Please hold."       | —                   |

#### Edges

| From          | To            | Condition type     | Condition                              |
|---------------|---------------|--------------------|----------------------------------------|
| Greeting      | Receptionist  | default            | —                                      |
| Receptionist  | Booking       | LLM condition      | caller wants to book or reschedule     |
| Receptionist  | Cancellation  | LLM condition      | caller wants to cancel                 |
| Receptionist  | Escalation    | LLM condition      | caller requests human or has emergency  |
| Receptionist  | Receptionist  | default (stay)     | caller asks FAQ — answer with tools     |
| Booking       | Confirmation  | default            | booking or callback request completed  |
| Cancellation  | Confirmation  | default            | cancellation completed                  |
| Confirmation  | Receptionist  | default (loop)     | "Is there anything else I can help with?"|
| Escalation    | (terminal)    | —                  | call transferred via Call Control API  |

Stretch goal: Receptionist → Escalation via variable comparison
(`telnyx_conversation_duration_secs >= 300`).

#### Node prompts (system prompt outlines)

**Greeting (speak node):**
```
Thank you for calling Bright Smile Dental. This call may be recorded
for quality and training purposes. How can I help you today?
```

**Receptionist (prompt node):**
```
You are Sarah, the virtual receptionist at Bright Smile Dental.
Your job: identify what the caller needs and use the right tool.
If the caller asks about services, hours, or location, use get_business_info
or get_services to answer.
If the caller wants to book or reschedule an appointment, say so briefly
and the workflow will route you.
If the caller wants to cancel, say so briefly and the workflow will route you.
If the caller has a dental emergency or asks for a human, say so briefly.
Be warm, concise, and professional. Never make up information — check with tools.
```

**Booking (prompt node):**
```
You are Sarah, helping the caller book a dental appointment.
Steps (you manage the turns):
1. Ask the reason for the visit and their preferred date.
   If no preferred date, search from today.
2. Call check_availability to find open slots.
3. Present the first available slot (or offer alternatives if asked).
4. Once the caller confirms a slot, ask for their name.
5. Call book_appointment with the details.
If online_booking_enabled is false, explain that the request has been noted
and our staff will confirm the appointment as soon as possible.
Be concise. Confirm details before booking. Never make up slot times.
```

**Cancellation (prompt node):**
```
You are Sarah, helping the caller cancel or reschedule an appointment.
Steps:
1. Confirm the caller's phone number (from the dynamic variable caller_phone).
2. Call cancel_appointment to find and cancel their appointment.
3. Confirm what was cancelled.
If rescheduling, guide them to book a new appointment.
Be concise and confirm before cancelling.
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

### 3. Webhook Edge Function (TypeScript)

Deployed on Telnyx Edge Compute via `telnyx-edge ship`.
URL: `https://webhook-<org>.telnyxcompute.com`

**Responsibilities:**
- Receive webhook calls before each node transition.
- Read/update the `CallSession` Stateful Actor (per-caller state).
- Read KV (feature flags, cached clinic hours, counters).
- Return dynamic variables to the workflow.
- Structured JSON log on every call (caller, node, outcome, latency).
- On Escalation node entry: call Telnyx Call Control API to transfer the call.

**Bindings (in `func.toml`):**
- `KV` — `env.KV` (TypeScript env binding)
- `Actor` — `CallSession` class via `StatefulActor`

**Dynamic variables returned:**

| Variable                 | Source   | Used by                |
|--------------------------|----------|------------------------|
| `caller_name`            | Actor    | Greeting personalization|
| `caller_phone`           | webhook  | MCP tool calls         |
| `online_booking_enabled` | KV flag  | Booking node logic     |
| `clinic_hours`           | KV cache | Receptionist FAQ       |
| `current_intent`         | Actor    | Receptionist context   |

### 4. MCP Server (Python, edge function)

Deployed on Telnyx Edge Compute via `telnyx-edge ship`.
URL: `https://mcp-server-<org>.telnyxcompute.com`

**Transport:** MCP over HTTP (JSON-RPC POST requests).

**Tools (5):**

| Tool                 | Args                              | Returns                          | Used in        |
|----------------------|-----------------------------------|----------------------------------|----------------|
| `check_availability` | `date_from`, `date_to?`           | List of available slots         | Booking        |
| `book_appointment`   | `name`, `phone`, `slot`, `reason` | Booking confirmation             | Booking        |
| `cancel_appointment` | `phone`, `booking_id?`            | Cancellation confirmation        | Cancellation   |
| `get_services`       | —                                 | Services with prices/descriptions| Receptionist   |
| `get_business_info`  | —                                 | Hours, location, policies        | Receptionist   |

**Data store:** in-memory dict of appointments (resets on cold start — fine for demo).

### 5. KV (Key-Value Store)

| Key                      | Value              | Purpose                          |
|--------------------------|--------------------|----------------------------------|
| `online_booking_enabled` | `true`/`false`     | Feature flag: book now or note as callback |
| `clinic_hours`           | JSON hours object  | Cached clinic hours for FAQ      |
| `webhook_calls:{caller}` | integer            | Observability: call count per caller |
| `webhook_errors:{caller}`| integer            | Observability: error count       |
| `webhook_latency:{node}` | integer (ms)       | Observability: last latency per node |

### 6. Stateful Actor — CallSession

One actor per caller, keyed by `caller:+{phone}`.

**State fields:**

| Field             | Type   | Purpose                                     |
|-------------------|--------|---------------------------------------------|
| `callerName`      | string | Name if previously provided                 |
| `currentIntent`   | string | What the caller is doing this call          |
| `bookingDetails`   | object | Partial booking (reason, date, slot)       |
| `lastBookingId`   | string | Booking ID if a booking was made            |
| `callStartTime`   | number | Timestamp for duration tracking             |

**Read-modify-write:** each webhook call reads the session, updates it
with the current node's data, and writes it back.
Single-threaded guarantee prevents races on rapid node transitions.

### 7. Observability

**Structured logs (every webhook call):**
```json
{
  "timestamp": "ISO-8601",
  "caller": "+1234567890",
  "node": "Booking",
  "intent": "booking",
  "outcome": "slot_offered",
  "latency_ms": 42,
  "actor_key": "caller:+1234567890"
}
```

**Signal beyond logs:** KV counters (calls per caller, errors, latency per node).
Readable via a simple GET endpoint on the edge function.

**How you'd know it broke within 1 minute:**
1. KV `webhook_errors:{caller}` spiking → the webhook is failing for a caller.
2. Latency counter for a node > 2000ms → the MCP server or KV is slow.
3. No webhook calls arriving → the assistant isn't hitting the webhook (config wrong).
4. Telnyx portal call logs → conversation side: node transitions, tool calls, transcripts.

## Folder structure

```
edge-functions/
  webhook/                     # TypeScript — dynamic webhook variables + KV + Actor
    src/
      handler.ts               # webhook HTTP handler
      actor.ts                  # CallSession StatefulActor class
      variables.ts             # dynamic variable assembly
      types.ts
    tests/
    func.toml                  # KV + Actor bindings
    package.json
  mcp-server/                  # Python — MCP server with scheduling tools
    src/
      server.py                # MCP HTTP transport handler
      tools.py                 # tool implementations
      data.py                   # in-memory appointment store
    tests/
    func.toml
    pyproject.toml
assistant-voice-agent/         # assistant configuration
  workflow.json                # conversation workflow definition (or portal export)
  prompts/                     # system prompt per node
    greeting.txt
    receptionist.txt
    booking.txt
    cancellation.txt
    confirmation.txt
    escalation.txt
  setup.py                     # script to create assistant + assign phone via API
docs/
  architecture.md              # this file
  adr/                         # architecture decision records
  prd/                         # product requirement docs
  agents/                      # agent-facing docs
```

## Deployment

| Component          | Platform             | Deploy command                    | URL                                |
|--------------------|-----------------------|-----------------------------------|-------------------------------------|
| Webhook            | Telnyx Edge Compute  | `telnyx-edge ship` (from webhook/) | `https://webhook-<org>.telnyxcompute.com` |
| MCP server         | Telnyx Edge Compute  | `telnyx-edge ship` (from mcp-server/) | `https://mcp-server-<org>.telnyxcompute.com` |
| Assistant + workflow | Telnyx portal/API   | `setup.py` or portal             | phone number assigned               |
| Phone number       | Telnyx portal        | assign to assistant              | dial-in number                      |

All on Telnyx. No external hosting needed.

## Build order

1. **MCP server** (Python edge function) — scaffold, implement 5 tools, test locally, ship.
2. **Webhook edge function** (TypeScript) — scaffold, implement Actor + KV + dynamic vars, ship.
3. **Assistant + workflow** — create in portal (or via API), configure MCP URL, set up webhook URL,
   build the 6-node workflow, assign phone number.
4. **Test end-to-end** — call the number, walk through each workflow path.
5. **Observability** — verify logs and KV counters, write the "what broke" story.
6. **Documentation** — README with setup, architecture, observability story, demo script.
