export { CallSession } from "./actor/call-session.js";

import type { Env } from "./types.js";
import { handleWebhook } from "./handlers/webhook.js";
import { handleMetrics } from "./handlers/metrics.js";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health" || url.pathname.startsWith("/health/")) {
      return new Response("ok");
    }

    if (url.pathname === "/metrics" && req.method === "GET") {
      return handleMetrics(env);
    }

    if (req.method === "POST") {
      return handleWebhook(req, env);
    }

    return Response.json({
      name: "Bright Smile Dental Webhook",
      status: "running",
      endpoints: {
        "POST /": "Dynamic variables webhook (called by Telnyx AI Assistant)",
        "GET /metrics": "Observability counters",
        "GET /health": "Liveness probe",
      },
    });
  },
};
