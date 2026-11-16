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

describe("KV service", () => {
  describe("getFeatureFlag", () => {
    it("returns the stored value when present", async () => {
      const { getFeatureFlag } = await import("../src/services/kv.js");
      const env = createMockEnv({ online_booking_enabled: "false" });
      expect(await getFeatureFlag(env, "online_booking_enabled")).toBe("false");
    });

    it("defaults to 'true' when the key is missing", async () => {
      const { getFeatureFlag } = await import("../src/services/kv.js");
      const env = createMockEnv({});
      expect(await getFeatureFlag(env, "online_booking_enabled")).toBe("true");
    });
  });

  describe("getClinicHours", () => {
    it("returns hours from the business_info JSON blob when KV has it", async () => {
      const { getClinicHours } = await import("../src/services/kv.js");
      const env = createMockEnv({
        business_info: JSON.stringify({
          name: "Bright Smile Dental",
          hours: "Mon-Thu 7am-7pm",
          location: "123 Smile Ave",
          phone: "+12175551234",
          policy: "Arrive 15 min early.",
        }),
      });
      expect(await getClinicHours(env)).toBe("Mon-Thu 7am-7pm");
    });

    it("falls back to the default hours string when KV has no business_info", async () => {
      const { getClinicHours } = await import("../src/services/kv.js");
      const env = createMockEnv({});
      const hours = await getClinicHours(env);
      expect(hours).toContain("Mon-Fri");
      expect(hours).toContain("Sat");
    });

    it("falls back to the default when business_info is malformed JSON", async () => {
      const { getClinicHours } = await import("../src/services/kv.js");
      const env = createMockEnv({ business_info: "not json {{" });
      const hours = await getClinicHours(env);
      expect(hours).toContain("Mon-Fri");
    });

    it("falls back to the default when business_info lacks the hours field", async () => {
      const { getClinicHours } = await import("../src/services/kv.js");
      const env = createMockEnv({
        business_info: JSON.stringify({ name: "X" }),
      });
      const hours = await getClinicHours(env);
      expect(hours).toContain("Mon-Fri");
    });
  });

  describe("incrementCounter", () => {
    it("writes '1' when the key does not exist", async () => {
      const { incrementCounter } = await import("../src/services/kv.js");
      const data: Record<string, string> = {};
      const env = createMockEnv(data);
      await incrementCounter(env, "webhook_calls");
      expect(data["webhook_calls"]).toBe("1");
    });

    it("increments an existing numeric value by 1", async () => {
      const { incrementCounter } = await import("../src/services/kv.js");
      const data: Record<string, string> = { webhook_calls: "41" };
      const env = createMockEnv(data);
      await incrementCounter(env, "webhook_calls");
      expect(data["webhook_calls"]).toBe("42");
    });

    it("writes only KV-valid key names (no colons, no plus)", async () => {
      const { incrementCounter } = await import("../src/services/kv.js");
      const data: Record<string, string> = {};
      const env = createMockEnv(data);
      await incrementCounter(env, "webhook_calls/15551234567");
      const validKey = /^[a-zA-Z0-9_\-\/=.]+$/;
      for (const key of Object.keys(data)) {
        expect(validKey.test(key), `key "${key}" contains invalid chars`).toBe(true);
      }
    });
  });

  describe("getCounter", () => {
    it("parses a stored integer", async () => {
      const { getCounter } = await import("../src/services/kv.js");
      const env = createMockEnv({ webhook_calls: "7" });
      expect(await getCounter(env, "webhook_calls")).toBe(7);
    });

    it("returns 0 when the key is missing", async () => {
      const { getCounter } = await import("../src/services/kv.js");
      const env = createMockEnv({});
      expect(await getCounter(env, "webhook_calls")).toBe(0);
    });

    it("returns 0 instead of NaN for a non-numeric stored value", async () => {
      const { getCounter } = await import("../src/services/kv.js");
      const env = createMockEnv({ webhook_calls: "oops" });
      expect(await getCounter(env, "webhook_calls")).toBe(0);
    });
  });
});
