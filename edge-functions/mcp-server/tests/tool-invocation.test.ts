import { describe, it, expect } from "vitest";
import { BookingActor } from "../src/actor.js";

function callTool(
  name: string,
  args: Record<string, unknown> = {},
  conversationId?: string
): Request {
  const params: Record<string, unknown> = { name, arguments: args };
  if (conversationId) {
    params._meta = { telnyx_conversation_id: conversationId };
  }
  return new Request("http://localhost/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params,
    }),
  });
}

function createFakeBookingBinding(): { idFromName(name: string): unknown } {
  const actors = new Map<string, unknown>();
  return {
    idFromName(name: string) {
      let a = actors.get(name);
      if (!a) {
        const storage = new Map<string, unknown>();
        const fakeStorage = {
          get: async (k: string) => (storage.get(k) ?? null) as unknown,
          put: async (k: string, v: unknown) => {
            storage.set(k, v);
          },
        };
        const actor = Object.create(BookingActor.prototype) as object;
        Object.assign(actor, { ctx: { storage: fakeStorage } });
        a = actor;
        actors.set(name, a);
      }
      return a;
    },
  };
}

async function callHandler(
  req: Request,
  env?: { BOOKING?: { idFromName(name: string): unknown } }
): Promise<{
  status: number;
  body: {
    jsonrpc: string;
    id: number;
    result?: { content: { type: string; text: string }[]; isError?: boolean };
    error?: { code: number; message: string };
  };
}> {
  const handler = (await import("../src/index.js")).default;
  const res = await handler.fetch(req, env as Record<string, unknown> | undefined);
  return { status: res.status, body: JSON.parse(await res.text()) };
}

function resultText(
  body: Awaited<ReturnType<typeof callHandler>>["body"]
): string {
  return body.result?.content?.[0]?.text ?? "";
}

describe("MCP tool invocation via tools/call", () => {
  it("get_business_info returns the clinic record", async () => {
    const { body } = await callHandler(callTool("get_business_info"));
    expect(body.result).toBeDefined();
    const info = JSON.parse(resultText(body));
    expect(info.name).toBe("Bright Smile Dental");
    expect(info.hours).toContain("Mon-Fri");
    expect(info.location).toBeDefined();
  });

  it("get_services returns a list with at least three priced services", async () => {
    const { body } = await callHandler(callTool("get_services"));
    const services = JSON.parse(resultText(body));
    expect(Array.isArray(services)).toBe(true);
    expect(services.length).toBeGreaterThanOrEqual(3);
    expect(typeof services[0].price).toBe("number");
  });

  it("check_availability returns slots for a future weekday", async () => {
    const { body } = await callHandler(
      callTool("check_availability", { date_from: "2026-12-02" })
    );
    const slots = JSON.parse(resultText(body));
    expect(Array.isArray(slots)).toBe(true);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0].time).toBeDefined();
    expect(slots[0].dentist).toBeDefined();
  });

  it("check_availability returns an empty-list message for a Sunday", async () => {
    const { body } = await callHandler(
      callTool("check_availability", { date_from: "2026-12-06" })
    );
    const text = resultText(body);
    expect(text.toLowerCase()).toContain("no available slots");
  });

  it("check_availability supports a date range", async () => {
    const { body } = await callHandler(
      callTool("check_availability", {
        date_from: "2026-12-02",
        date_to: "2026-12-03",
      })
    );
    const slots = JSON.parse(resultText(body));
    const dates = new Set(slots.map((s: { date: string }) => s.date));
    expect(dates.has("2026-12-02")).toBe(true);
    expect(dates.has("2026-12-03")).toBe(true);
  });

  it("update_booking_draft saves a field and returns the draft plus status", async () => {
    const env = { BOOKING: createFakeBookingBinding() };
    const { body } = await callHandler(
      callTool(
        "update_booking_draft",
        {
          caller_phone: "+10000000001",
          field: "reason",
          value: "cleaning",
        },
        "conversation-1001"
      ),
      env
    );
    const parsed = JSON.parse(resultText(body));
    expect(parsed.draft.reason).toBe("cleaning");
    expect(parsed.status).toBeDefined();
    expect(parsed.status.nextStep).toBe("ask_preferred_date");
  });

  it("get_booking_status returns an empty draft for a new caller", async () => {
    const env = { BOOKING: createFakeBookingBinding() };
    const { body } = await callHandler(
      callTool(
        "get_booking_status",
        { caller_phone: "+10000000002" },
        "conversation-1002"
      ),
      env
    );
    const parsed = JSON.parse(resultText(body));
    expect(parsed.draft).toBeNull();
    expect(parsed.status.nextStep).toBe("ask_reason");
  });

  it("end-to-end booking flow: update drafts → book → cancel", async () => {
    const env = { BOOKING: createFakeBookingBinding() };
    const phone = "+10000000003";
    const conv = "conversation-1003";

    await callHandler(
      callTool(
        "update_booking_draft",
        { caller_phone: phone, field: "reason", value: "dental exam" },
        conv
      ),
      env
    );
    await callHandler(
      callTool(
        "update_booking_draft",
        { caller_phone: phone, field: "preferredDate", value: "2026-12-03" },
        conv
      ),
      env
    );
    await callHandler(
      callTool(
        "update_booking_draft",
        {
          caller_phone: phone,
          field: "slot",
          value: { date: "2026-12-03", time: "10:00", dentist: "Dr. Lee" },
        },
        conv
      ),
      env
    );
    await callHandler(
      callTool(
        "update_booking_draft",
        { caller_phone: phone, field: "name", value: "Eval Patient" },
        conv
      ),
      env
    );

    const bookRes = await callHandler(
      callTool("book_appointment", { caller_phone: phone }, conv),
      env
    );
    const booking = JSON.parse(resultText(bookRes.body));
    expect(booking.bookingId).toMatch(/^BK-\d+$/);
    expect(booking.date).toBe("2026-12-03");
    expect(booking.time).toBe("10:00");
    expect(booking.dentist).toBe("Dr. Lee");
    expect(booking.confirmed).toBe(true);

    const cancelRes = await callHandler(
      callTool("cancel_appointment", { caller_phone: phone }, conv),
      env
    );
    const cancelled = JSON.parse(resultText(cancelRes.body));
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.date).toBe("2026-12-03");
  });

  it("each conversation has isolated state (two callers do not share draft)", async () => {
    const env = { BOOKING: createFakeBookingBinding() };
    await callHandler(
      callTool(
        "update_booking_draft",
        {
          caller_phone: "+10000000010",
          field: "reason",
          value: "cleaning-A",
        },
        "conversation-A"
      ),
      env
    );
    await callHandler(
      callTool(
        "update_booking_draft",
        {
          caller_phone: "+10000000011",
          field: "reason",
          value: "cleaning-B",
        },
        "conversation-B"
      ),
      env
    );
    const a = await callHandler(
      callTool(
        "get_booking_status",
        { caller_phone: "+10000000010" },
        "conversation-A"
      ),
      env
    );
    const b = await callHandler(
      callTool(
        "get_booking_status",
        { caller_phone: "+10000000011" },
        "conversation-B"
      ),
      env
    );
    expect(JSON.parse(resultText(a.body)).draft.reason).toBe("cleaning-A");
    expect(JSON.parse(resultText(b.body)).draft.reason).toBe("cleaning-B");
  });

  it("book_appointment returns an error message (not a throw) for missing fields", async () => {
    const env = { BOOKING: createFakeBookingBinding() };
    const phone = "+10000000004";
    const conv = "conversation-1004";
    await callHandler(
      callTool(
        "update_booking_draft",
        { caller_phone: phone, field: "reason", value: "cleaning" },
        conv
      ),
      env
    );

    const { body, status } = await callHandler(
      callTool("book_appointment", { caller_phone: phone }, conv),
      env
    );
    expect(status).toBe(200);
    const text = resultText(body);
    expect(text).toContain("Error");
    expect(text.toLowerCase()).toContain("missing");
  });

  it("cancel_appointment returns cancelled:false for a caller with no booking", async () => {
    const env = { BOOKING: createFakeBookingBinding() };
    const { body } = await callHandler(
      callTool(
        "cancel_appointment",
        { caller_phone: "+19998887777" },
        "conversation-1005"
      ),
      env
    );
    const parsed = JSON.parse(resultText(body));
    expect(parsed.cancelled).toBe(false);
    expect(parsed.reason.toLowerCase()).toContain("no booking");
  });
});
