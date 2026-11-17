import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Store } from "./store/index.js";
import type { BusinessInfo, Service } from "./store/index.js";
import { createMcpServer } from "./tools/index.js";
import { createBookingActorStub } from "./actor.js";

interface EnvBookingBinding {
  idFromName(name: string): unknown;
}

interface Env {
  CLINIC_KV?: { get(key: string): Promise<string | null> };
  BOOKING?: EnvBookingBinding;
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

/**
 * Extract the Telnyx conversation id from a JSON-RPC request body. Telnyx
 * injects `telnyx_conversation_id` into the `_meta` field of every MCP
 * request. The field can sit at the top level (initialize) or inside
 * `params._meta` (tools/call, tools/list, …).
 */
async function extractConversationId(req: Request): Promise<string | null> {
  try {
    const peek = await req.clone().json();
    const top = peek?._meta?.telnyx_conversation_id;
    if (typeof top === "string" && top) return top;
    const nested = peek?.params?._meta?.telnyx_conversation_id;
    if (typeof nested === "string" && nested) return nested;
  } catch {
    // Not JSON or no _meta — fall through.
  }
  return null;
}

function buildStore(env: Env, conversationId: string | null): Store {
  const store = new Store();
  if (cachedBusinessInfo && cachedServices) {
    store.setStaticData(cachedBusinessInfo, cachedServices);
  }
  if (conversationId && env?.BOOKING) {
    const raw = env.BOOKING.idFromName(`conv:${conversationId}`) as {
      getDraft(): unknown;
      updateDraft(...args: unknown[]): unknown;
      getDraftStatus(): unknown;
      createBooking(...args: unknown[]): unknown;
      cancelBooking(): unknown;
      getBookedSlotForDate(...args: unknown[]): unknown;
    };
    const stub = createBookingActorStub(raw);
    store.setActorBackend(stub, conversationId);
  }
  return store;
}

export default {
  async fetch(req: Request, env?: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health" || url.pathname.startsWith("/health/")) {
      return new Response("ok");
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
      const conversationId = await extractConversationId(req);
      const store = buildStore(env ?? {}, conversationId);
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
