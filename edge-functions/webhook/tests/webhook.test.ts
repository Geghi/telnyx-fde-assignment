import { describe, it, expect } from "vitest";
import type { Env } from "../src/types.js";

function createMockEnv(kvData: Record<string, string> = {}): Env {
  const kv = kvData;
  return {
    CLINIC_KV: {
      get: async (key: string) => kv[key] ?? null,
      put: async (key: string, value: string) => { kv[key] = value; },
      delete: async (key: string) => { delete kv[key]; },
      list: async () => ({ keys: [], list_complete: true }),
    },
    CALL_SESSION: {
      idFromName: () => createMockActor(),
    },
  } as unknown as Env;
}

function createMockActor() {
  let state: { callerName: string | null; lastBookingId: string | null; totalCalls: number } = {
    callerName: null,
    lastBookingId: null,
    totalCalls: 0,
  };
  return {
    getOrCreate: async () => state,
    recordCall: async () => {
      state = { ...state, totalCalls: state.totalCalls + 1 };
      return { totalCalls: state.totalCalls };
    },
    updateCallerName: async (name: string) => {
      state = { ...state, callerName: name };
    },
    setLastBooking: async (bookingId: string) => {
      state = { ...state, lastBookingId: bookingId };
    },
  };
}

describe("handleWebhook", () => {
  it("returns dynamic variables for a new caller", async () => {
    const { handleWebhook } = await import("../src/handlers/webhook.js");
    const env = createMockEnv({ online_booking_enabled: "true" });

    const req = new Request("http://localhost/", {
      method: "POST",
      body: JSON.stringify({
        data: {
          event_type: "assistant.initialization",
          payload: {
            telnyx_conversation_channel: "phone_call",
            telnyx_agent_target: "+13128675309",
            telnyx_end_user_target: "+15551234567",
            call_control_id: "v3:test123",
            assistant_id: "assistant_test",
          },
        },
      }),
    });

    const res = await handleWebhook(req, env);
    const body = await res.json();
    expect(body.dynamic_variables.caller_phone).toBe("+15551234567");
    expect(body.dynamic_variables.caller_name).toBe("");
    expect(body.dynamic_variables.online_booking_enabled).toBe("true");
  });

  it("defaults online_booking_enabled to true when KV has no value", async () => {
    const { handleWebhook } = await import("../src/handlers/webhook.js");
    const env = createMockEnv({});

    const req = new Request("http://localhost/", {
      method: "POST",
      body: JSON.stringify({
        data: {
          event_type: "assistant.initialization",
          payload: {
            telnyx_conversation_channel: "phone_call",
            telnyx_agent_target: "+13128675309",
            telnyx_end_user_target: "+15551234567",
            call_control_id: "v3:test123",
            assistant_id: "assistant_test",
          },
        },
      }),
    });

    const res = await handleWebhook(req, env);
    const body = await res.json();
    expect(body.dynamic_variables.online_booking_enabled).toBe("true");
  });

  it("uses cached clinic_hours from KV", async () => {
    const { handleWebhook } = await import("../src/handlers/webhook.js");
    const env = createMockEnv({
      clinic_hours: "Mon-Thu 7am-7pm, Fri 8am-4pm",
      online_booking_enabled: "true",
    });

    const req = new Request("http://localhost/", {
      method: "POST",
      body: JSON.stringify({
        data: {
          event_type: "assistant.initialization",
          payload: {
            telnyx_conversation_channel: "phone_call",
            telnyx_agent_target: "+13128675309",
            telnyx_end_user_target: "+15551234567",
            call_control_id: "v3:test123",
            assistant_id: "assistant_test",
          },
        },
      }),
    });

    const res = await handleWebhook(req, env);
    const body = await res.json();
    expect(body.dynamic_variables.clinic_hours).toBe("Mon-Thu 7am-7pm, Fri 8am-4pm");
  });

  it("returns 400 for invalid payload", async () => {
    const { handleWebhook } = await import("../src/handlers/webhook.js");
    const env = createMockEnv();

    const req = new Request("http://localhost/", {
      method: "POST",
      body: JSON.stringify({ data: null }),
    });

    const res = await handleWebhook(req, env);
    expect(res.status).toBe(400);
  });

  it("returns 400 for unparseable body", async () => {
    const { handleWebhook } = await import("../src/handlers/webhook.js");
    const env = createMockEnv();

    const req = new Request("http://localhost/", {
      method: "POST",
      body: "not json",
    });

    const res = await handleWebhook(req, env);
    expect(res.status).toBe(400);
  });

  it("increments the per-caller webhook call counter in KV", async () => {
    const { handleWebhook } = await import("../src/handlers/webhook.js");
    const env = createMockEnv({ online_booking_enabled: "true" });

    function makeReq() {
      return new Request("http://localhost/", {
        method: "POST",
        body: JSON.stringify({
          data: {
            event_type: "assistant.initialization",
            payload: {
              telnyx_conversation_channel: "phone_call",
              telnyx_agent_target: "+13128675309",
              telnyx_end_user_target: "+15551234567",
              call_control_id: "v3:test123",
              assistant_id: "assistant_test",
            },
          },
        }),
      });
    }

    await handleWebhook(makeReq(), env);
    await handleWebhook(makeReq(), env);
    const count = await env.CLINIC_KV.get("webhook_calls:+15551234567");
    expect(count).toBe("2");
  });
});
