import type { Env, WebhookPayload, DynamicVariablesResponse } from "../types.js";
import { createCallSessionStub } from "../actor/call-session.js";
import { getFeatureFlag, getClinicHours, incrementCounter } from "../services/kv.js";
import { assembleDynamicVariables } from "../services/variables.js";

function logEvent(level: "log" | "error", fields: Record<string, unknown>): void {
  console[level](JSON.stringify({ timestamp: new Date().toISOString(), ...fields }));
}

export async function handleWebhook(
  req: Request,
  env: Env
): Promise<Response> {
  const start = Date.now();

  const body = (await req.json().catch(() => null)) as WebhookPayload | null;
  if (!body?.data?.payload) {
    await incrementCounter(env, "webhook_errors").catch(() => {});
    logEvent("error", { outcome: "invalid_payload", latency_ms: Date.now() - start });
    return Response.json({ error: "Invalid payload" }, { status: 400 });
  }

  const payload = body.data.payload;
  const callerPhone = payload.telnyx_end_user_target ?? "";
  const trace = {
    event: body.data.event_type,
    caller: callerPhone,
    call_control_id: payload.call_control_id,
    actor_key: `caller:${callerPhone}`,
  };

  try {
    const stub = createCallSessionStub(env.CALL_SESSION.idFromName(`caller:${callerPhone}`));
    const session = await stub.getOrCreate();
    await stub.recordCall();

    const onlineBookingEnabled = await getFeatureFlag(env, "online_booking_enabled");
    const clinicHours = await getClinicHours(env);

    await incrementCounter(env, "webhook_calls").catch(() => {});
    await incrementCounter(env, `webhook_calls/${callerPhone.replace(/^\+/, "")}`).catch(() => {});

    const response: DynamicVariablesResponse = assembleDynamicVariables({
      session,
      callerPhone,
      onlineBookingEnabled,
      clinicHours,
    });

    logEvent("log", {
      ...trace,
      outcome: "ok",
      latency_ms: Date.now() - start,
      returning_caller: session.totalCalls > 0,
    });

    return Response.json(response);
  } catch (err) {
    await incrementCounter(env, "webhook_errors").catch(() => {});
    logEvent("error", { ...trace, outcome: "error", error: String(err), latency_ms: Date.now() - start });
    throw err;
  }
}
