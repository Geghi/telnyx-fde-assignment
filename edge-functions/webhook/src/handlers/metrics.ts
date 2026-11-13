import type { Env, Metrics } from "../types.js";
import { getCounter } from "../services/kv.js";

export async function handleMetrics(env: Env): Promise<Response> {
  const totalCalls = await getCounter(env, "webhook_calls").catch(() => 0);
  const totalErrors = await getCounter(env, "webhook_errors").catch(() => 0);

  const metrics: Metrics = {
    webhookCalls: totalCalls,
    webhookErrors: totalErrors,
  };

  return Response.json(metrics);
}
