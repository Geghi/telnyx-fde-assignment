import { describe, it, expect } from "vitest";
import { assembleDynamicVariables } from "../src/services/variables.js";
import type { CallSessionState } from "../src/types.js";

describe("assembleDynamicVariables", () => {
  const baseSession: CallSessionState = {
    callerName: null,
    lastBookingId: null,
    totalCalls: 0,
  };

  it("returns empty caller_name for a new caller", () => {
    const result = assembleDynamicVariables({
      session: baseSession,
      callerPhone: "+15551234567",
      onlineBookingEnabled: "true",
      clinicHours: "Mon-Fri 8am-6pm",
    });
    expect(result.dynamic_variables.caller_name).toBe("");
  });

  it("returns caller_name for a returning caller", () => {
    const result = assembleDynamicVariables({
      session: { ...baseSession, callerName: "John", totalCalls: 2 },
      callerPhone: "+15551234567",
      onlineBookingEnabled: "true",
      clinicHours: "Mon-Fri 8am-6pm",
    });
    expect(result.dynamic_variables.caller_name).toBe("John");
  });

  it("passes caller_phone from the webhook payload", () => {
    const result = assembleDynamicVariables({
      session: baseSession,
      callerPhone: "+15551234567",
      onlineBookingEnabled: "true",
      clinicHours: "Mon-Fri 8am-6pm",
    });
    expect(result.dynamic_variables.caller_phone).toBe("+15551234567");
  });

  it("passes the online_booking_enabled flag", () => {
    const result = assembleDynamicVariables({
      session: baseSession,
      callerPhone: "+15551234567",
      onlineBookingEnabled: "false",
      clinicHours: "Mon-Fri 8am-6pm",
    });
    expect(result.dynamic_variables.online_booking_enabled).toBe("false");
  });

  it("passes cached clinic_hours", () => {
    const result = assembleDynamicVariables({
      session: baseSession,
      callerPhone: "+15551234567",
      onlineBookingEnabled: "true",
      clinicHours: "Mon-Fri 8am-6pm, Sat 9am-2pm, Sun closed",
    });
    expect(result.dynamic_variables.clinic_hours).toBe(
      "Mon-Fri 8am-6pm, Sat 9am-2pm, Sun closed"
    );
  });

  it("returns exactly 4 dynamic variables", () => {
    const result = assembleDynamicVariables({
      session: baseSession,
      callerPhone: "+15551234567",
      onlineBookingEnabled: "true",
      clinicHours: "Mon-Fri 8am-6pm",
    });
    expect(Object.keys(result.dynamic_variables)).toHaveLength(4);
  });
});
