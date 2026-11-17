import { describe, it, expect } from "vitest";
import { webhookToolDefinitions, WEBHOOK_TOOL_NAMES } from "../src/webhook-tools.js";

const BASE = "https://mcp-server-x.telnyxcompute.com";

describe("webhookToolDefinitions", () => {
  const defs = webhookToolDefinitions(BASE);

  it("defines one webhook tool per caller operation", () => {
    expect(defs.map((d) => d.display_name)).toEqual([...WEBHOOK_TOOL_NAMES]);
    for (const d of defs) expect(d.type).toBe("webhook");
  });

  it("points each tool at its /tools/<name> route with POST", () => {
    for (const d of defs) {
      expect(d.webhook.url).toBe(`${BASE}/tools/${d.display_name}`);
      expect(d.webhook.method).toBe("POST");
    }
  });

  it("injects caller_phone as a preset the LLM never sees", () => {
    for (const d of defs) {
      expect(d.webhook.preset_body_fields).toEqual({ caller_phone: "{{caller_phone}}" });
      expect(Object.keys(d.webhook.body_parameters.properties)).not.toContain("caller_phone");
    }
  });

  it("strips a trailing slash from the base URL", () => {
    const [first] = webhookToolDefinitions(`${BASE}/`);
    expect(first.webhook.url).toBe(`${BASE}/tools/${first.display_name}`);
  });

  it("gives every body parameter a type (Telnyx rejects schemas without one)", () => {
    for (const d of defs) {
      for (const prop of Object.values(d.webhook.body_parameters.properties)) {
        expect(prop).toHaveProperty("type");
      }
    }
  });

  it("asks the LLM for field + value or slot only on update_booking_draft", () => {
    const draft = defs.find((d) => d.display_name === "update_booking_draft")!;
    expect(draft.webhook.body_parameters.required).toEqual(["field"]);
    expect(Object.keys(draft.webhook.body_parameters.properties)).toEqual(["field", "value", "slot"]);
    const others = defs.filter((d) => d.display_name !== "update_booking_draft");
    for (const d of others) expect(d.webhook.body_parameters.properties).toEqual({});
  });
});
