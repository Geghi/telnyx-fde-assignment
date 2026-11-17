import { describe, it, expect, vi } from "vitest";

function post(req: Request) {
  return req;
}

function initRequest() {
  return new Request("http://localhost/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    }),
  });
}

describe("MCP server edge handler", () => {
  it("responds ok on GET /health", async () => {
    const handler = (await import("../src/index.js")).default;
    const res = await handler.fetch(
      new Request("http://localhost/health", { method: "GET" })
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("returns server info JSON on GET /", async () => {
    const handler = (await import("../src/index.js")).default;
    const res = await handler.fetch(
      new Request("http://localhost/", { method: "GET" })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toContain("Bright Smile Dental MCP");
    expect(body.status).toBe("running");
  });

  it("answers JSON-RPC initialize with 200 and a result", async () => {
    const handler = (await import("../src/index.js")).default;
    const res = await handler.fetch(post(initRequest()));
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result).toBeDefined();
    expect(body.result.protocolVersion).toBeDefined();
  });

  it("lists only the 3 read tools via tools/list (writes are webhook tools)", async () => {
    const handler = (await import("../src/index.js")).default;
    const res = await handler.fetch(
      post(
        new Request("http://localhost/", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {},
          }),
        })
      )
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body.result.tools.length).toBe(3);
    const names = body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      "check_availability",
      "get_business_info",
      "get_services",
    ]);
  });

  it("logs each JSON-RPC tools/call with the tool name, status and latency", async () => {
    const handler = (await import("../src/index.js")).default;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await handler.fetch(
        new Request("http://localhost/", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "get_business_info", arguments: {} },
          }),
        })
      );
      const events = log.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line));
      expect(events).toContainEqual(
        expect.objectContaining({
          event: "mcp_request",
          method: "tools/call",
          tool: "get_business_info",
          status: 200,
          latency_ms: expect.any(Number),
        })
      );
    } finally {
      log.mockRestore();
    }
  });
});
