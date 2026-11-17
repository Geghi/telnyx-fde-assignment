# Telnyx terms: interview cheat sheet

One line for what each term is, one for how this project uses it.

## Voice AI side (managed by Telnyx)

**AI Assistant**: a hosted voice bot. It bundles an LLM, speech-to-text, text-to-speech, tools and a phone number.
→ Ours is "Sarah", model `zai-org/GLM-5.3-Flash`, created through the API by `setup.ts`.

**Conversation Workflow** (`conversation_flow`): a graph of nodes and edges. The call is always "on" exactly one node.
→ 9 nodes, 15 edges, defined in `assistant-voice-agent/workflow.json`.

**Prompt node**: an LLM step. It has its own instructions and tools, the LLM talks, and the LLM decides when to leave.
→ Receptionist, Booking, Booking request, Cancellation, Confirmation.

**Speak node**: says a fixed text word for word, with no LLM. Use it for anything that must be said exactly (disclosures). It needs exactly **one default edge**.
→ Greeting (includes the "this call may be recorded" disclosure), Escalation, and Callback confirmation ("they'll call you back as soon as possible": a promise, so it must be word for word).

**Tool node**: runs one tool deterministically, with no LLM turn. It can be terminal.
→ Transfer runs the shared transfer tool to the front desk.

**Edge**: an arrow between nodes, with a condition. Three kinds:
- **Default edge**: always taken. Used after speak and tool nodes (Greeting→Receptionist, Escalation→Transfer, Callback confirmation→Receptionist, Transfer→Receptionist when the transfer fails).
- **LLM-condition edge**: a natural-language condition ("the caller wants to cancel"). Telnyx shows it to the LLM as a tool named `transition__<edge_id>`, and the LLM "calls" it to move. If the LLM calls none, the call stays on the node. → All our intent routing works this way.
- **Variable-comparison edge**: a deterministic check on a variable (`telnyx_conversation_duration_secs >= 300`, `online_booking_enabled == "false"`). No LLM involved. JSON: `{"type":"expression","expression":{"type":"comparison","op":"==","left":{"type":"variable","name":"online_booking_enabled"},"right":{"type":"string_literal","value":"false"}}}`. On a prompt node it is checked **before the model's turn** and wins over LLM edges.
→ Booking → Booking request when `online_booking_enabled == "false"`. The flag comes from KV through the dynamic-variables webhook, so flipping it changes routing without a redeploy.

**`instructions_mode`** (`append` | `replace`): `append` adds the node's prompt to the assistant's global prompt. `replace` throws the global prompt away for that node.
→ All our prompt nodes use `append`, so the Sarah persona and rules carry through every node.

**`tools_mode`** (`append` | `replace`, default `replace`) + **`shared_tool_ids`**: per-node tool scoping, but only for **shared (org-level) tools** from `/ai/tools`. The API docs say `tools_mode` is ignored when `shared_tool_ids` is null.
→ Booking: `shared_tool_ids` = [update_booking_draft, get_booking_status, book_appointment], `tools_mode: "append"`. Cancellation: [cancel_appointment], `append`. `append` means the node keeps the assistant-wide MCP read tools and adds its own write tools. Receptionist and Confirmation list no shared tools, so they can't call any write.

**MCP tool scoping**: MCP servers attach at the assistant level (`mcp_servers[]`). `allowed_tools` filters them for the whole assistant. There is no per-node MCP control. Verified: the Portal's Booking node → "Override assistant tools" shows "No assistant tools to inherit" while the MCP server is attached. The per-node list only covers shared and inline tools, never MCP tools.
→ Our split: **reads on MCP** (`get_business_info`, `get_services`, `check_availability`), which every node may call, and that's harmless. **Writes as shared webhook tools**, scoped per node. Telnyx can't scope MCP per node, so the boundary sits where the risk is.

**Dynamic variables**: `{{name}}` placeholders in prompts.
**Dynamic variables webhook**: a URL Telnyx POSTs to **once, at call start** (`assistant.initialization`). The JSON it returns fills the variables for the whole call. The default timeout is 1.5 s; ours is 8 s.
→ Our webhook returns `caller_phone`, `caller_name`, `online_booking_enabled`, `clinic_hours`, `today_date`, `weekday`, `week_snapshot`, and others.

**System variables**: values Telnyx fills in itself: `telnyx_end_user_target` (caller number), `telnyx_agent_target` (our number), `telnyx_conversation_duration_secs`, `telnyx_last_tool_status_code`.

**Preset parameters** (`preset_body_fields`, `preset_query_params` on a webhook tool): fixed fields Telnyx always adds to the request, hidden from the LLM and filled from variables. Verified with a probe on a Portal voice test: `{{caller_phone}}`, `{{telnyx_end_user_target}}`, `{{call_control_id}}`, `{{telnyx_conversation_channel}}` and `{{telnyx_conversation_id}}` (undocumented) all arrived filled. In the Portal test the caller is a SIP URI (`…@sip.telnyx.eu`), not a phone number. Every request also carries `x-telnyx-call-control-id` and the `telnyx-signature-ed25519` / `telnyx-timestamp` headers.

**Shared tool**: a tool defined once at account level (`/ai/tools`) and referenced by id. Ours is the `transfer` tool, used by the Transfer node.

**MCP server (on the assistant)**: Telnyx calls our MCP server's tools over HTTP (Streamable HTTP, JSON-RPC). Every request carries `_meta.telnyx_conversation_id`. Ours exposes the 3 read-only tools.

**Webhook tool**: a shared tool that makes a plain HTTP request. Ours hit `POST <mcp-server>/tools/<name>` on the same edge function, reusing the same store and actor. `caller_phone` arrives as a preset field.

## Edge Compute side (our code)

**Edge Function**: serverless TypeScript deployed with `telnyx-edge ship`, served at `https://<name>-<id>.telnyxcompute.com`. It's stateless: instances come and go, and two requests can land on different instances.
→ `webhook` and `mcp-server`.

**`telnyx.toml`**: the function manifest, which declares bindings (KV, actors). You need this "umbrella" manifest, not `func.toml`, once you use actors.

**Binding**: how config exposes a resource to your code as `env.X`. → `env.CLINIC_KV`, `env.CALL_SESSION`, `env.BOOKING`.

**KV**: a global key-value store. Simple get and put, no locking, and reads can be slightly stale.
Good for config, flags and caches. Bad for read-modify-write.
→ `business_info` (clinic config, shared by both functions), the `online_booking_enabled` flag, and counters.

**Stateful Actor**: a class with its own private storage, one instance per key (`env.BINDING.idFromName(key)`). It's **single-threaded per key**: calls to the same key run one at a time, so read-modify-write is safe without a lock.
→ `CallSession` (key `caller:+phone`, counts calls across calls) and `BookingActor` (key `caller:+phone`, holds the draft and the booking, so a booking made on one call can be cancelled on the next).

**Why an actor and not KV for the draft?** The LLM can fire two `update_booking_draft` calls in parallel. With KV, both read the old draft and the last write wins, so a field gets lost. The actor runs them one after the other.
**Why not keep it in memory?** Each tool request can hit a different function instance, so a draft held in memory can vanish between turns.

## Words they may use

- **Append vs replace**: covered above.
- **Tool scoping per node**: giving each node only the tools it needs. Fewer choices means more reliable tool calls.
- **Variable comparison vs LLM condition**: use a variable when the fact is known and deterministic (a flag, a timeout). Use the LLM when it depends on what the caller means.
- **Multi-assistant routing**: an edge that hands the call to a different assistant. A stretch goal we didn't do.
