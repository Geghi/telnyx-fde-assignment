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
    CALL_SESSION: { idFromName: () => ({} as never) },
  } as unknown as Env;
}

describe("handleMetrics", () => {
  it("returns the current call and error counters from KV", async () => {
    const { handleMetrics } = await import("../src/handlers/metrics.js");
    const env = createMockEnv({
      webhook_calls: "5",
      webhook_errors: "2",
    });

    const res = await handleMetrics(env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ webhookCalls: 5, webhookErrors: 2 });
  });

  it("defaults both counters to 0 when KV is empty", async () => {
    const { handleMetrics } = await import("../src/handlers/metrics.js");
    const env = createMockEnv({});

    const res = await handleMetrics(env);
    const body = await res.json();
    expect(body).toEqual({ webhookCalls: 0, webhookErrors: 0 });
  });

  it("parses non-numeric stored values as 0 (NaN guard)", async () => {
    const { handleMetrics } = await import("../src/handlers/metrics.js");
    const env = createMockEnv({
      webhook_calls: "not-a-number",
      webhook_errors: "",
    });

    const res = await handleMetrics(env);
    const body = await res.json();
    expect(body.webhookCalls).toBe(0);
    expect(body.webhookErrors).toBe(0);
  });
});
