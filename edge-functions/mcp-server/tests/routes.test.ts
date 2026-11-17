import { describe, it, expect, vi } from "vitest";
import { BookingActor } from "../src/actor.js";

type Binding = { idFromName(name: string): unknown; keys: string[] };

function createFakeBookingBinding(): Binding {
  const actors = new Map<string, unknown>();
  return {
    keys: [],
    idFromName(name: string) {
      this.keys.push(name);
      let a = actors.get(name);
      if (!a) {
        const storage = new Map<string, unknown>();
        const actor = Object.create(BookingActor.prototype) as object;
        Object.assign(actor, {
          ctx: {
            storage: {
              get: async (k: string) => (storage.get(k) ?? null) as unknown,
              put: async (k: string, v: unknown) => void storage.set(k, v),
            },
          },
        });
        a = actor;
        actors.set(name, a);
      }
      return a;
    },
  };
}

async function callRoute(
  tool: string,
  body: unknown,
  env: Env = { BOOKING: createFakeBookingBinding() },
  method = "POST"
): Promise<{ status: number; json: any }> {
  const handler = (await import("../src/index.js")).default;
  const res = await handler.fetch(
    new Request(`http://localhost/tools/${tool}`, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify(body) : undefined,
    }),
    env as never
  );
  return { status: res.status, json: await res.json() };
}

type Env = {
  BOOKING?: Binding;
  CLINIC_KV?: { get(key: string): Promise<string | null> };
  STAFF_TOKEN?: string;
};

function fakeKv(values: Record<string, string>) {
  return { get: async (k: string) => values[k] ?? null };
}

async function getCallbacks(env: Env, token?: string) {
  const handler = (await import("../src/index.js")).default;
  const res = await handler.fetch(
    new Request("http://localhost/callbacks", {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
    env as never
  );
  return { status: res.status, json: await res.json() };
}

const PHONE = "+15551230000";

const callerKeys = (b: Binding) => [...new Set(b.keys.filter((k) => k.startsWith("caller:")))];

async function fillDraft(env: { BOOKING: Binding }, phone = PHONE) {
  await callRoute("update_booking_draft", { caller_phone: phone, field: "reason", value: "cleaning" }, env);
  await callRoute("update_booking_draft", { caller_phone: phone, field: "preferredDate", value: "2026-12-03" }, env);
  await callRoute(
    "update_booking_draft",
    { caller_phone: phone, field: "slot", slot: { date: "2026-12-03", time: "10:00", dentist: "Dr. Lee" } },
    env
  );
  await callRoute("update_booking_draft", { caller_phone: phone, field: "name", value: "Jane" }, env);
}

describe("webhook tool routes (POST /tools/<name>)", () => {
  it("update_booking_draft saves a field and returns draft + status", async () => {
    const { status, json } = await callRoute("update_booking_draft", {
      caller_phone: PHONE,
      field: "reason",
      value: "cleaning",
    });
    expect(status).toBe(200);
    expect(json.draft.reason).toBe("cleaning");
    expect(json.status.nextStep).toBe("ask_preferred_date");
  });

  it("update_booking_draft takes the slot as a separate `slot` object", async () => {
    const { status, json } = await callRoute("update_booking_draft", {
      caller_phone: PHONE,
      field: "slot",
      slot: { date: "2026-12-03", time: "10:00", dentist: "Dr. Lee" },
    });
    expect(status).toBe(200);
    expect(json.draft.slot).toEqual({ date: "2026-12-03", time: "10:00", dentist: "Dr. Lee" });
  });

  it("accepts the unused optional parameter as null (Telnyx sends omitted params as null)", async () => {
    const { status, json } = await callRoute("update_booking_draft", {
      caller_phone: PHONE,
      field: "reason",
      value: "tooth extraction",
      slot: null,
    });
    expect(status).toBe(200);
    expect(json.draft.reason).toBe("tooth extraction");
  });

  it.each([
    [{ field: "slot", value: "10am", slot: null }, "slot field with a null slot"],
    [{ field: "slot", value: "10am" }, "slot without a slot object"],
    [{ field: "name" }, "text field without value"],
  ])("rejects %j with 400 (%s)", async (args, _label) => {
    const { status, json } = await callRoute("update_booking_draft", { caller_phone: PHONE, ...args });
    expect(status).toBe(400);
    expect(json.error).toBeTruthy();
  });

  it("keys the BookingActor by caller, not by conversation", async () => {
    const env = { BOOKING: createFakeBookingBinding() };
    await callRoute("get_booking_status", { caller_phone: PHONE }, env);
    expect(callerKeys(env.BOOKING)).toEqual([`caller:${PHONE}`]);
  });

  it("get_booking_status returns an empty draft for a new caller", async () => {
    const { json } = await callRoute("get_booking_status", { caller_phone: PHONE });
    expect(json.draft).toBeNull();
    expect(json.status.nextStep).toBe("ask_reason");
  });

  it("books from the draft, and a later request from the same caller can cancel it", async () => {
    const env = { BOOKING: createFakeBookingBinding() };
    await fillDraft(env);

    const booked = await callRoute("book_appointment", { caller_phone: PHONE }, env);
    expect(booked.status).toBe(200);
    expect(booked.json.bookingId).toMatch(/^BK-\d+$/);
    expect(booked.json).toMatchObject({ date: "2026-12-03", time: "10:00", dentist: "Dr. Lee" });

    const cancelled = await callRoute("cancel_appointment", { caller_phone: PHONE }, env);
    expect(cancelled.json).toEqual({ cancelled: true, kind: "booking", date: "2026-12-03" });
  });

  it("isolates state between callers", async () => {
    const env = { BOOKING: createFakeBookingBinding() };
    await callRoute("update_booking_draft", { caller_phone: "+1001", field: "reason", value: "A" }, env);
    await callRoute("update_booking_draft", { caller_phone: "+1002", field: "reason", value: "B" }, env);
    const a = await callRoute("get_booking_status", { caller_phone: "+1001" }, env);
    const b = await callRoute("get_booking_status", { caller_phone: "+1002" }, env);
    expect(a.json.draft.reason).toBe("A");
    expect(b.json.draft.reason).toBe("B");
  });

  it("book_appointment with an incomplete draft returns 200 with an error the LLM can read", async () => {
    const env = { BOOKING: createFakeBookingBinding() };
    await callRoute("update_booking_draft", { caller_phone: PHONE, field: "reason", value: "cleaning" }, env);
    const { status, json } = await callRoute("book_appointment", { caller_phone: PHONE }, env);
    expect(status).toBe(200);
    expect(json.error.toLowerCase()).toContain("missing");
  });

  it("cancel_appointment without a booking returns cancelled:false", async () => {
    const { json } = await callRoute("cancel_appointment", { caller_phone: PHONE });
    expect(json.cancelled).toBe(false);
  });

  it.each([["", "empty"], ["{{caller_phone}}", "unresolved template"], [undefined, "missing"]])(
    "falls back to the 'unknown' caller when caller_phone is %j (%s)",
    async (phone, _label) => {
      const env = { BOOKING: createFakeBookingBinding() };
      await callRoute("get_booking_status", { caller_phone: phone }, env);
      expect(callerKeys(env.BOOKING)).toEqual(["caller:unknown"]);
    }
  );

  it("rejects an invalid draft field with 400", async () => {
    const { status } = await callRoute("update_booking_draft", {
      caller_phone: PHONE,
      field: "dentist",
      value: "x",
    });
    expect(status).toBe(400);
  });

  it("rejects a non-JSON body with 400", async () => {
    const handler = (await import("../src/index.js")).default;
    const res = await handler.fetch(
      new Request("http://localhost/tools/get_booking_status", { method: "POST", body: "nope" }),
      { BOOKING: createFakeBookingBinding() } as never
    );
    expect(res.status).toBe(400);
  });

  it("returns a generic 500 when the actor fails, without leaking the error", async () => {
    const broken = {
      keys: [] as string[],
      idFromName: () => ({
        getDraft: async () => {
          throw new Error("storage exploded: secret detail");
        },
        getDraftStatus: async () => ({ nextStep: "ask_reason", missingFields: [] }),
      }),
    };
    const { status, json } = await callRoute("get_booking_status", { caller_phone: PHONE }, { BOOKING: broken });
    expect(status).toBe(500);
    expect(JSON.stringify(json)).not.toContain("secret detail");
  });

  it("logs each tool route call with caller, status and latency", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await callRoute("get_booking_status", { caller_phone: PHONE });
      const events = log.mock.calls.map((c) => JSON.parse(String(c[0])));
      expect(events).toContainEqual(
        expect.objectContaining({
          event: "tool_call",
          tool: "get_booking_status",
          caller: PHONE,
          status: 200,
          latency_ms: expect.any(Number),
        })
      );
    } finally {
      log.mockRestore();
    }
  });

  it("returns 404 for an unknown tool", async () => {
    const { status } = await callRoute("drop_tables", { caller_phone: PHONE });
    expect(status).toBe(404);
  });

  it("returns 405 for GET", async () => {
    const { status } = await callRoute("get_booking_status", undefined, undefined, "GET");
    expect(status).toBe(405);
  });

  describe("callback requests (online booking disabled)", () => {
    async function fillRequestDraft(env: { BOOKING: Binding }, phone = PHONE) {
      await callRoute("update_booking_draft", { caller_phone: phone, field: "reason", value: "cleaning" }, env);
      await callRoute("update_booking_draft", { caller_phone: phone, field: "preferredDate", value: "2026-12-03" }, env);
      await callRoute("update_booking_draft", { caller_phone: phone, field: "name", value: "Jane" }, env);
    }

    it("save_booking_request saves the draft as a request without a slot", async () => {
      const env = { BOOKING: createFakeBookingBinding() };
      await fillRequestDraft(env);
      const { status, json } = await callRoute("save_booking_request", { caller_phone: PHONE }, env);
      expect(status).toBe(200);
      expect(json).toMatchObject({
        requestId: "RQ-0001",
        status: "callback_requested",
        name: "Jane",
        reason: "cleaning",
        preferredDate: "2026-12-03",
        slot: null,
      });
    });

    it("save_booking_request names the missing fields when the draft is incomplete", async () => {
      const env = { BOOKING: createFakeBookingBinding() };
      await callRoute("update_booking_draft", { caller_phone: PHONE, field: "reason", value: "cleaning" }, env);
      const { status, json } = await callRoute("save_booking_request", { caller_phone: PHONE }, env);
      expect(status).toBe(200);
      expect(json.error).toContain("preferredDate");
      expect(json.error).toContain("name");
    });

    it("book_appointment refuses when the KV flag disables online booking", async () => {
      const env = { BOOKING: createFakeBookingBinding(), CLINIC_KV: fakeKv({ online_booking_enabled: "false" }) };
      await fillDraft(env);
      const { status, json } = await callRoute("book_appointment", { caller_phone: PHONE }, env);
      expect(status).toBe(200);
      expect(json.error).toMatch(/save_booking_request/);
      expect(json.bookingId).toBeUndefined();
    });

    it("book_appointment works when the KV flag is true", async () => {
      const env = { BOOKING: createFakeBookingBinding(), CLINIC_KV: fakeKv({ online_booking_enabled: "true" }) };
      await fillDraft(env);
      const { json } = await callRoute("book_appointment", { caller_phone: PHONE }, env);
      expect(json.bookingId).toMatch(/^BK-/);
    });

    it("lists saved requests on GET /callbacks for staff with the token", async () => {
      const env = { BOOKING: createFakeBookingBinding(), STAFF_TOKEN: "s3cret" };
      await fillRequestDraft(env, "+1001");
      await callRoute("save_booking_request", { caller_phone: "+1001" }, env);
      await fillRequestDraft(env, "+1002");
      await callRoute("save_booking_request", { caller_phone: "+1002" }, env);

      const { status, json } = await getCallbacks(env, "s3cret");
      expect(status).toBe(200);
      expect(json.map((r: { callerPhone: string }) => r.callerPhone)).toEqual(["+1001", "+1002"]);
    });

    it.each([[undefined, "no token"], ["wrong", "wrong token"]])(
      "rejects GET /callbacks with %s (%s)",
      async (token, _label) => {
        const env = { BOOKING: createFakeBookingBinding(), STAFF_TOKEN: "s3cret" };
        const { status } = await getCallbacks(env, token);
        expect(status).toBe(401);
      }
    );

    it("disables GET /callbacks when no STAFF_TOKEN is configured", async () => {
      const { status } = await getCallbacks({ BOOKING: createFakeBookingBinding() }, "anything");
      expect(status).toBe(401);
    });

    it("cancel_appointment cancels a pending request and removes it from the staff list", async () => {
      const env = { BOOKING: createFakeBookingBinding(), STAFF_TOKEN: "t" };
      await fillRequestDraft(env);
      await callRoute("save_booking_request", { caller_phone: PHONE }, env);

      const { json } = await callRoute("cancel_appointment", { caller_phone: PHONE }, env);
      expect(json).toEqual({ cancelled: true, kind: "request", date: "2026-12-03" });
      expect((await getCallbacks(env, "t")).json).toEqual([]);
    });
  });

  describe("get_appointment", () => {
    it("returns the confirmed booking", async () => {
      const env = { BOOKING: createFakeBookingBinding() };
      await fillDraft(env);
      await callRoute("book_appointment", { caller_phone: PHONE }, env);
      const { json } = await callRoute("get_appointment", { caller_phone: PHONE }, env);
      expect(json.booking).toMatchObject({ bookingId: "BK-0001", slot: { time: "10:00" } });
      expect(json.request).toBeNull();
    });

    it("returns nulls when the caller has nothing", async () => {
      const { json } = await callRoute("get_appointment", { caller_phone: PHONE });
      expect(json).toEqual({ booking: null, request: null });
    });
  });
});
