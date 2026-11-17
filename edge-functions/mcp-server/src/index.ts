import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Store } from "./store/index.js";
import type { BusinessInfo, Service } from "./store/index.js";
import { createMcpServer } from "./tools/index.js";
import { createBookingActorStub, createCallbackQueueStub } from "./actor.js";
import type { CallbackQueueStub } from "./actor.js";
import { callerKey, isToolName, runTool } from "./routes.js";

// Re-export so esbuild keeps the class in the bundle. Telnyx Edge only
// registers this function as the actor's owner if it sees the exported
// `BookingActor` class in the shipped bundle — with `sideEffects: false`
// (needed to pass the secret scanner) an unused export gets tree-shaken.
export { BookingActor } from "./actor.js";

interface EnvBookingBinding {
  idFromName(name: string): unknown;
}

interface Env {
  CLINIC_KV?: { get(key: string): Promise<string | null> };
  BOOKING?: EnvBookingBinding;
  /** Bearer token for GET /callbacks (telnyx-edge secrets add STAFF_TOKEN …). Unset → endpoint disabled. */
  STAFF_TOKEN?: string;
}

function callbackQueue(env: Env): CallbackQueueStub | null {
  return env?.BOOKING ? createCallbackQueueStub(env.BOOKING.idFromName("clinic:callbacks")) : null;
}

/** Same flag and default as the webhook: missing or unreadable means enabled. */
async function onlineBookingEnabled(env: Env): Promise<boolean> {
  const value = await env?.CLINIC_KV?.get("online_booking_enabled").catch(() => null);
  return value !== "false";
}

async function handleCallbacks(req: Request, env: Env): Promise<Response> {
  // telnyx-edge secrets are documented as "environment variables"; accept the env binding or process.env.
  const token = env?.STAFF_TOKEN ?? (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.STAFF_TOKEN;
  const auth = req.headers.get("authorization");
  if (!token || auth !== `Bearer ${token}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const queue = callbackQueue(env);
  return Response.json(queue ? await queue.listCallbacks() : []);
}

let cachedBusinessInfo: BusinessInfo | null = null;
let cachedServices: Service[] | null = null;

async function getCachedStaticConfig(env: Env): Promise<{
  businessInfo: BusinessInfo;
  services: Service[];
}> {
  if (cachedBusinessInfo && cachedServices) {
    return { businessInfo: cachedBusinessInfo, services: cachedServices };
  }
  const loader = new Store();
  if (env?.CLINIC_KV) {
    try {
      await loader.initFromKv(env.CLINIC_KV);
      console.log(
        `[mcp-server] static config loaded from KV: name="${loader.getBusinessInfo().name}"`
      );
    } catch (err) {
      console.error("[mcp-server] KV init failed, using defaults:", err);
    }
  } else {
    console.log("[mcp-server] no CLINIC_KV binding — using defaults");
  }
  cachedBusinessInfo = loader.getBusinessInfo();
  cachedServices = loader.getServices();
  return { businessInfo: cachedBusinessInfo, services: cachedServices };
}

function buildStore(env: Env, caller: string | null): Store {
  const store = new Store();
  if (cachedBusinessInfo && cachedServices) {
    store.setStaticData(cachedBusinessInfo, cachedServices);
  }
  if (caller && env?.BOOKING) {
    store.setActorBackend(createBookingActorStub(env.BOOKING.idFromName(`caller:${caller}`)));
  }
  return store;
}

async function handleToolRoute(req: Request, name: string, env: Env): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (!isToolName(name)) {
    return Response.json({ error: `Unknown tool: ${name}` }, { status: 404 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const caller = callerKey(body?.caller_phone);
  let res: Response;
  try {
    res = await runTool(name, body ?? {}, {
      store: buildStore(env, caller),
      caller,
      queue: callbackQueue(env),
      onlineBookingEnabled: () => onlineBookingEnabled(env),
    });
  } catch (err) {
    console.error(JSON.stringify({ event: "tool_error", tool: name, caller, error: String(err) }));
    return Response.json({ error: "Internal error, please try again" }, { status: 500 });
  }
  console.log(JSON.stringify({ event: "tool_call", tool: name, caller, status: res.status }));
  return res;
}

export default {
  async fetch(req: Request, env?: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health" || url.pathname.startsWith("/health/")) {
      return new Response("ok");
    }

    if (url.pathname === "/callbacks" && req.method === "GET") {
      return handleCallbacks(req, env ?? {});
    }

    if (url.pathname.startsWith("/tools/")) {
      return handleToolRoute(req, url.pathname.slice("/tools/".length), env ?? {});
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/mcp")) {
      return Response.json({
        name: "Bright Smile Dental MCP Server",
        version: "1.0.0",
        status: "running",
        endpoint: "POST JSON-RPC messages to this URL",
      });
    }

    if (req.method === "POST" || req.method === "GET" || req.method === "DELETE") {
      await getCachedStaticConfig(env ?? {});
      const store = buildStore(env ?? {}, null);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const mcpServer = createMcpServer(store);
      await mcpServer.connect(transport);
      try {
        return await transport.handleRequest(req);
      } catch (err) {
        console.error("MCP request error:", err);
        return Response.json(
          { error: "Internal server error" },
          { status: 500 }
        );
      }
    }

    return Response.json({ error: "Method not allowed" }, { status: 405 });
  },
};
