import type { Env, WebhookPayload, DynamicVariablesResponse } from "../types.js";
import { createCallSessionStub } from "../actor/call-session.js";
import { getFeatureFlag, getClinicHours, incrementCounter } from "../services/kv.js";
import { assembleDynamicVariables } from "../services/variables.js";

export async function handleWebhook(
  req: Request,
  env: Env
): Promise<Response> {
  const start = Date.now();

  const body = (await req.json().catch(() => null)) as WebhookPayload | null;
  if (!body?.data?.payload) {
    await incrementCounter(env, "webhook_errors").catch(() => {});
    return Response.json({ error: "Invalid payload" }, { status: 400 });
  }

  const payload = body.data.payload;
  const callerPhone = payload.telnyx_end_user_target ?? "";

  const stub = createCallSessionStub(env.CALL_SESSION.idFromName(`caller:${callerPhone}`));
  const session = await stub.getOrCreate();
  await stub.recordCall();

  const onlineBookingEnabled = await getFeatureFlag(env, "online_booking_enabled");
  const clinicHours = await getClinicHours(env);

  await incrementCounter(env, `webhook_calls:${callerPhone}`).catch(() => {});

  const response = assembleDynamicVariables({
    session,
    callerPhone,
    onlineBookingEnabled,
    clinicHours,
  });

  const latency = Date.now() - start;
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event: body.data.event_type,
      caller: callerPhone,
      outcome: "ok",
      latency_ms: latency,
      returning_caller: session.totalCalls > 0,
      actor_key: `caller:${callerPhone}`,
    })
  );

  return Response.json(response);
}
