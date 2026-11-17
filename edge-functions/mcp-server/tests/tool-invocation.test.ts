import { describe, it, expect } from "vitest";

function callTool(name: string, args: Record<string, unknown> = {}): Request {
  const params: Record<string, unknown> = { name, arguments: args };
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

async function callHandler(req: Request): Promise<{
  status: number;
  body: {
    jsonrpc: string;
    id: number;
    result?: { content: { type: string; text: string }[]; isError?: boolean };
    error?: { code: number; message: string };
  };
}> {
  const handler = (await import("../src/index.js")).default;
  const res = await handler.fetch(req);
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
});
