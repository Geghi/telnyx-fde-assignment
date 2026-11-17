/**
 * Per-caller tools, registered as shared webhook tools (`/ai/tools`) so the
 * workflow can scope them per node. They hit `POST <mcp-server>/tools/<name>`.
 * `caller_phone` is a preset field: Telnyx fills it from the `caller_phone`
 * dynamic variable and the LLM never sees or supplies it.
 */

export const WEBHOOK_TOOL_NAMES = [
  "update_booking_draft",
  "get_booking_status",
  "book_appointment",
  "save_booking_request",
  "get_appointment",
  "cancel_appointment",
] as const;

export type WebhookToolName = (typeof WEBHOOK_TOOL_NAMES)[number];

interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
}

export interface WebhookToolDefinition {
  type: "webhook";
  display_name: WebhookToolName;
  webhook: {
    name: WebhookToolName;
    description: string;
    url: string;
    method: "POST";
    body_parameters: JsonSchemaObject;
    preset_body_fields: { caller_phone: string };
  };
}

const NO_ARGS: JsonSchemaObject = { type: "object", properties: {}, required: [] };

const SPECS: Record<WebhookToolName, { description: string; body: JsonSchemaObject }> = {
  update_booking_draft: {
    description:
      "Saves one piece of booking information as the caller provides it. Returns the current draft and a status with nextStep and missingFields — follow nextStep. Call it again to correct a field.",
    body: {
      type: "object",
      properties: {
        field: {
          type: "string",
          enum: ["reason", "preferredDate", "slot", "name"],
          description: "The draft field to update",
        },
        value: {
          type: "string",
          description: "The value for reason, preferredDate (YYYY-MM-DD) or name. Omit when field is 'slot'.",
        },
        slot: {
          type: "object",
          description: "Only when field is 'slot': the slot the caller confirmed, as returned by check_availability.",
          properties: {
            date: { type: "string", description: "YYYY-MM-DD" },
            time: { type: "string", description: "HH:MM" },
            dentist: { type: "string" },
          },
          required: ["date", "time", "dentist"],
        },
      },
      required: ["field"],
    },
  },
  get_booking_status: {
    description:
      "Returns the caller's current booking draft and its status (nextStep, missingFields). Call it first to see whether a draft already exists.",
    body: NO_ARGS,
  },
  book_appointment: {
    description:
      "Creates the confirmed booking from the caller's draft once every field is filled. Returns bookingId, date, time and dentist, or an error naming the missing fields.",
    body: NO_ARGS,
  },
  save_booking_request: {
    description:
      "Online booking is off: saves the caller's draft (reason, preferredDate, name; slot optional) as a call-back request for the front desk. Returns the request, or an error naming the missing fields. It does NOT book an appointment.",
    body: NO_ARGS,
  },
  get_appointment: {
    description:
      "Looks up the caller's current appointment. Returns {booking, request}: booking is a confirmed appointment (date, time, dentist), request is a pending call-back request. Either can be null. Read-only.",
    body: NO_ARGS,
  },
  cancel_appointment: {
    description:
      "Cancels the caller's confirmed appointment, or their pending call-back request if there is no appointment. Returns {cancelled: true, kind, date} or {cancelled: false, reason}.",
    body: NO_ARGS,
  },
};

export function webhookToolDefinitions(mcpServerUrl: string): WebhookToolDefinition[] {
  const base = mcpServerUrl.replace(/\/+$/, "");
  return WEBHOOK_TOOL_NAMES.map((name) => ({
    type: "webhook",
    display_name: name,
    webhook: {
      name,
      description: SPECS[name].description,
      url: `${base}/tools/${name}`,
      method: "POST",
      body_parameters: SPECS[name].body,
      preset_body_fields: { caller_phone: "{{caller_phone}}" },
    },
  }));
}
