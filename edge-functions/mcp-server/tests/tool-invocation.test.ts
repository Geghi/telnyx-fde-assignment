import { describe, it, expect } from "vitest";

function callTool(name: string, args: Record<string, unknown> = {}): Request {
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
      params: { name, arguments: args },
    }),
  });
}

async function callHandler(req: Request): Promise<{
  status: number;
  body: { jsonrpc: string; id: number; result?: { content: { type: string; text: string }[]; isError?: boolean }; error?: { code: number; message: string } };
}> {
  const handler = (await import("../src/index.js")).default;
  const res = await handler.fetch(req);
  return { status: res.status, body: JSON.parse(await res.text()) };
}

function resultText(body: Awaited<ReturnType<typeof callHandler>>["body"]): string {
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
    const phone = "+10000000001";
    const { body } = await callHandler(
      callTool("update_booking_draft", {
        caller_phone: phone,
        field: "reason",
        value: "cleaning",
      })
    );
    const parsed = JSON.parse(resultText(body));
    expect(parsed.draft.reason).toBe("cleaning");
    expect(parsed.status).toBeDefined();
    expect(parsed.status.nextStep).toBe("ask_preferred_date");
  });

  it("get_booking_status returns an empty draft for a new caller", async () => {
    const { body } = await callHandler(
      callTool("get_booking_status", { caller_phone: "+10000000002" })
    );
    const parsed = JSON.parse(resultText(body));
    expect(parsed.draft).toBeNull();
    expect(parsed.status.nextStep).toBe("ask_reason");
  });

  it("end-to-end booking flow: update drafts → book → cancel", async () => {
    const phone = "+10000000003";

    await callHandler(
      callTool("update_booking_draft", {
        caller_phone: phone,
        field: "reason",
        value: "dental exam",
      })
    );
    await callHandler(
      callTool("update_booking_draft", {
        caller_phone: phone,
        field: "preferredDate",
        value: "2026-12-03",
      })
    );
    await callHandler(
      callTool("update_booking_draft", {
        caller_phone: phone,
        field: "slot",
        value: { date: "2026-12-03", time: "10:00", dentist: "Dr. Lee" },
      })
    );
    await callHandler(
      callTool("update_booking_draft", {
        caller_phone: phone,
        field: "name",
        value: "Eval Patient",
      })
    );

    const bookRes = await callHandler(
      callTool("book_appointment", { caller_phone: phone })
    );
    const booking = JSON.parse(resultText(bookRes.body));
    expect(booking.bookingId).toMatch(/^BK-\d+$/);
    expect(booking.date).toBe("2026-12-03");
    expect(booking.time).toBe("10:00");
    expect(booking.dentist).toBe("Dr. Lee");
    expect(booking.confirmed).toBe(true);

    const cancelRes = await callHandler(
      callTool("cancel_appointment", { caller_phone: phone })
    );
    const cancelled = JSON.parse(resultText(cancelRes.body));
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.date).toBe("2026-12-03");
  });

  it("book_appointment returns an error message (not a throw) for missing fields", async () => {
    const phone = "+10000000004";
    await callHandler(
      callTool("update_booking_draft", {
        caller_phone: phone,
        field: "reason",
        value: "cleaning",
      })
    );

    const { body, status } = await callHandler(
      callTool("book_appointment", { caller_phone: phone })
    );
    expect(status).toBe(200);
    const text = resultText(body);
    expect(text).toContain("Error");
    expect(text.toLowerCase()).toContain("missing");
  });

  it("cancel_appointment returns cancelled:false for a caller with no booking", async () => {
    const { body } = await callHandler(
      callTool("cancel_appointment", { caller_phone: "+19998887777" })
    );
    const parsed = JSON.parse(resultText(body));
    expect(parsed.cancelled).toBe(false);
    expect(parsed.reason.toLowerCase()).toContain("no booking");
  });
});
