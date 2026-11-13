import * as http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Store } from "./src/store.js";
import { createMcpServer } from "./src/tools.js";

const store = new Store();

const server = http.createServer(async (req, res) => {
  if (req.url === "/health" || req.url?.startsWith("/health/")) {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === "POST") {
    let body = "";
    for await (const chunk of req) {
      body += chunk.toString();
    }

    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      const mcpServer = createMcpServer(store);
      await mcpServer.connect(transport);

      const mockReq = {
        method: "POST",
        url: req.url || "/",
        headers: req.headers as Record<string, string>,
        body,
      };

      await transport.handleRequest(mockReq as any, res as any);
    } catch (err) {
      console.error("MCP request error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      name: "Bright Smile Dental MCP Server",
      version: "1.0.0",
      status: "running",
      endpoint: "POST JSON-RPC messages to this URL",
    })
  );
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`MCP server running on port ${port}`);
});
