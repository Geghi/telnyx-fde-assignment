import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Store } from "./store/index.js";
import { createMcpServer } from "./tools/index.js";

const store = new Store();

export default {
  async fetch(req: Request): Promise<Response> {
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
