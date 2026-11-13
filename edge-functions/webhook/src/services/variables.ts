import type { CallSessionState, DynamicVariablesResponse } from "../types.js";

export function assembleDynamicVariables(args: {
  session: CallSessionState;
  callerPhone: string;
  onlineBookingEnabled: string;
  clinicHours: string;
}): DynamicVariablesResponse {
  return {
    dynamic_variables: {
      caller_name: args.session.callerName ?? "",
      caller_phone: args.callerPhone,
      online_booking_enabled: args.onlineBookingEnabled,
      clinic_hours: args.clinicHours,
    },
  };
}
