import { describe, it, expect } from "vitest";
import { calendarSnapshot } from "../src/calendar.js";

describe("calendarSnapshot", () => {
  it("returns the local date as YYYY-MM-DD", () => {
    const snap = calendarSnapshot(new Date("2026-11-16T14:30:00"));
    expect(snap.today_date).toBe("2026-11-16");
    expect(snap.weekday).toBe("Mon");
    expect(snap.current_month).toBe("November");
    expect(snap.next_month).toBe("December");
  });

  it("week_snapshot starts at Monday of the current week (Mon..Sun)", () => {
    const snap = calendarSnapshot(new Date("2026-11-16T14:30:00")); // Mon
    expect(snap.week_snapshot).toBe("Mon 16, Tue 17, Wed 18, Thu 19, Fri 20, Sat 21, Sun 22");
  });

  it("week_snapshot rolls back to Monday when today is Sunday", () => {
    const snap = calendarSnapshot(new Date("2026-11-22T10:00:00")); // Sun
    expect(snap.weekday).toBe("Sun");
    expect(snap.week_snapshot).toBe("Mon 16, Tue 17, Wed 18, Thu 19, Fri 20, Sat 21, Sun 22");
  });

  it("week_snapshot rolls forward when today is Wednesday", () => {
    const snap = calendarSnapshot(new Date("2026-11-18T10:00:00")); // Wed
    expect(snap.weekday).toBe("Wed");
    expect(snap.week_snapshot).toBe("Mon 16, Tue 17, Wed 18, Thu 19, Fri 20, Sat 21, Sun 22");
  });

  it("next_month wraps from December to January", () => {
    const snap = calendarSnapshot(new Date("2026-12-05T10:00:00"));
    expect(snap.current_month).toBe("December");
    expect(snap.next_month).toBe("January");
  });
});
