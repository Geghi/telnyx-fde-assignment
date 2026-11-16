import type { CallSessionState, DynamicVariablesResponse } from "../types.js";
import { calendarSnapshot } from "./calendar.js";

export function assembleDynamicVariables(args: {
  session: CallSessionState;
  callerPhone: string;
  onlineBookingEnabled: string;
  clinicHours: string;
  now?: Date;
}): DynamicVariablesResponse {
  const cal = calendarSnapshot(args.now ?? new Date());
  return {
    dynamic_variables: {
      caller_name: args.session.callerName ?? "",
      caller_phone: args.callerPhone,
      online_booking_enabled: args.onlineBookingEnabled,
      clinic_hours: args.clinicHours,
      today_date: cal.today_date,
      weekday: cal.weekday,
      week_snapshot: cal.week_snapshot,
      current_month: cal.current_month,
      next_month: cal.next_month,
    },
  };
}
