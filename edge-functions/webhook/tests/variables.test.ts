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
  });  it("returns exactly 9 dynamic variables", () => {
    const result = assembleDynamicVariables({
      session: baseSession,
      callerPhone: "+15551234567",
      onlineBookingEnabled: "true",
      clinicHours: "Mon-Fri 8am-6pm",
    });
    expect(Object.keys(result.dynamic_variables)).toHaveLength(9);
  });

  it("injects a calendar snapshot for today (fixed date)", () => {
    const result = assembleDynamicVariables({
      session: baseSession,
      callerPhone: "+15551234567",
      onlineBookingEnabled: "true",
      clinicHours: "Mon-Fri 8am-6pm",
      now: new Date("2026-11-16T14:30:00"), // Mon Nov 16 2026
    });
    expect(result.dynamic_variables.today_date).toBe("2026-11-16");
    expect(result.dynamic_variables.weekday).toBe("Mon");
    expect(result.dynamic_variables.current_month).toBe("November");
    expect(result.dynamic_variables.next_month).toBe("December");
  });

  it("week_snapshot lists Mon..Sun of the current week with day numbers", () => {
    const result = assembleDynamicVariables({
      session: baseSession,
      callerPhone: "+15551234567",
      onlineBookingEnabled: "true",
      clinicHours: "Mon-Fri 8am-6pm",
      now: new Date("2026-11-16T14:30:00"), // Mon Nov 16 2026
    });
    expect(result.dynamic_variables.week_snapshot).toBe(
      "Mon 16, Tue 17, Wed 18, Thu 19, Fri 20, Sat 21, Sun 22"
    );
  });

  it("week_snapshot rolls back to Monday when today is Sunday", () => {
    const result = assembleDynamicVariables({
      session: baseSession,
      callerPhone: "+15551234567",
      onlineBookingEnabled: "true",
      clinicHours: "Mon-Fri 8am-6pm",
      now: new Date("2026-11-22T10:00:00"), // Sun Nov 22 2026
    });
    expect(result.dynamic_variables.weekday).toBe("Sun");
    expect(result.dynamic_variables.week_snapshot).toBe(
      "Mon 16, Tue 17, Wed 18, Thu 19, Fri 20, Sat 21, Sun 22"
    );
  });

  it("next_month wraps from December to January", () => {
    const result = assembleDynamicVariables({
      session: baseSession,
      callerPhone: "+15551234567",
      onlineBookingEnabled: "true",
      clinicHours: "Mon-Fri 8am-6pm",
      now: new Date("2026-12-05T10:00:00"), // Dec
    });
    expect(result.dynamic_variables.current_month).toBe("December");
    expect(result.dynamic_variables.next_month).toBe("January");
  });
});
