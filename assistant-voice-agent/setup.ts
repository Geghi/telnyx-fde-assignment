import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assembleWorkflow } from "./src/assemble-workflow.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function loadEnvFile() {
  const envPath = resolve(repoRoot, ".env.local");
  let content: string;
  try {
    content = readFileSync(envPath, "utf8");
  } catch (e) {
    const isMissing = (e as NodeJS.ErrnoException).code === "ENOENT";
    console.error(
      isMissing
        ? `Missing ${envPath}. Copy .env.example and fill in your values.`
        : `Could not read ${envPath}: ${(e as Error).message}`
    );
    process.exit(1);
  }
  let missingKeys = ["TELNYX_API_KEY", "MCP_SERVER_URL", "WEBHOOK_URL"];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = value;
    missingKeys = missingKeys.filter((k) => k !== m[1]);
  }
  const stillEmpty = missingKeys.filter((k) => !process.env[k]);
  if (stillEmpty.length) {
    console.error(
      `Missing or empty in .env.local: ${stillEmpty.join(", ")}. ` +
      `See .env.example for the expected keys.`
    );
    process.exit(1);
  }
}
loadEnvFile();

const API_BASE = "https://api.telnyx.com/v2";
const API_KEY = process.env.TELNYX_API_KEY;
const MCP_SERVER_URL = process.env.MCP_SERVER_URL;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const FRONT_DESK_NUMBER = process.env.FRONT_DESK_NUMBER ?? "";

const ASSISTANT_NAME = "Sarah — Bright Smile Dental";
const ASSISTANT_INSTRUCTIONS =
  "You are Sarah, the virtual receptionist at Bright Smile Dental. " +
  "This is a VOICE conversation — keep every response SHORT and spoken, never longer than 2-3 sentences. " +
  "Do not use bullet points, numbered lists, or markdown. " +
  "Ask ONE question at a time, then wait for the answer. " +
  "Never make up information — use tools. " +
  "Always tell the caller what you are doing before calling a tool (e.g. 'Let me check our calendar...').";
const MCP_SERVER_NAME = "bright-smile-dental-mcp";
const TRANSFER_TOOL_NAME = "Transfer to Front Desk";

function assertEnv(name: string, value: string | undefined): asserts value is string {
  if (!value) {
    console.error(`Missing ${name}. Set it in .env.local (see .env.example).`);
    process.exit(1);
  }
}

async function api(
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401) {
      const masked =
        API_KEY && API_KEY.length > 8
          ? `${API_KEY.slice(0, 4)}…${API_KEY.slice(-4)} (len=${API_KEY.length})`
          : API_KEY
          ? `<len=${API_KEY.length}>`
          : `<empty>`;
      throw new Error(
        `401 Authentication failed.\n` +
        `  Sent Authorization: Bearer ${masked}\n` +
        `  Check the key at portal.telnyx.com/#/app/api-keys:\n` +
        `  - it must be a Live API key (not Test)\n` +
        `  - copy it with no "Bearer " prefix\n` +
        `  - remove surrounding quotes/whitespace in .env.local`
      );
    }
    throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function findMcpServer(): Promise<string | null> {
  const list = await api("/ai/mcp_servers");
  const servers = Array.isArray(list) ? list : list.data ?? [];
  const existing = servers.find((s: { url: string }) => s.url === MCP_SERVER_URL);
  return existing?.id ?? null;
}

async function registerMcpServer(): Promise<string> {
  assertEnv("MCP_SERVER_URL", MCP_SERVER_URL);
  const existing = await findMcpServer();
  if (existing) {
    console.log(`MCP server already registered: ${existing}`);
    return existing;
  }
  const created = await api("/ai/mcp_servers", {
    method: "POST",
    body: {
      name: MCP_SERVER_NAME,
      type: "http",
      url: MCP_SERVER_URL,
    },
  });
  console.log(`MCP server created: ${created.id}`);
  return created.id;
}

async function findTransferTool(): Promise<string | null> {
  const list = await api("/ai/tools");
  const tools = list.data ?? [];
  const existing = tools.find((t: { display_name: string }) => t.display_name === TRANSFER_TOOL_NAME);
  return existing?.id ?? null;
}

async function createTransferTool(): Promise<string> {
  assertEnv("FRONT_DESK_NUMBER", FRONT_DESK_NUMBER);
  const existing = await findTransferTool();
  if (existing) {
    console.log(`Transfer tool already exists: ${existing}`);
    return existing;
  }
  const created = await api("/ai/tools", {
    method: "POST",
    body: {
      type: "transfer",
      display_name: TRANSFER_TOOL_NAME,
      transfer: {
        targets: [{ name: "Front Desk", to: FRONT_DESK_NUMBER }],
        from: "{{telnyx_agent_target}}",
      },
    },
  });
  console.log(`Transfer tool created: ${created.id}`);
  return created.id;
}

async function findAssistant(): Promise<string | null> {
  const list = await api("/ai/assistants");
  const assistants = list.data ?? [];
  const existing = assistants.find((a: { name: string }) => a.name === ASSISTANT_NAME);
  return existing?.id ?? null;
}

async function createOrUpdateAssistant(
  mcpServerId: string,
  transferToolId: string
): Promise<string> {
  assertEnv("WEBHOOK_URL", WEBHOOK_URL);
  const flow = assembleWorkflow({
    workflowPath: "workflow.json",
    promptsDir: "prompts",
    transferToolId,
  });

  const body = {
    name: ASSISTANT_NAME,
    instructions: ASSISTANT_INSTRUCTIONS,
    dynamic_variables_webhook_url: WEBHOOK_URL,
    dynamic_variables_webhook_timeout_ms: 8000,
    dynamic_variables: {
      caller_name: "",
      caller_phone: "",
      online_booking_enabled: "true",
      clinic_hours: "Mon-Fri 8am-6pm, Sat 9am-2pm, Sun closed",
    },
    mcp_servers: [{ id: mcpServerId }],
    conversation_flow: flow,
    enabled_features: ["telephony"],
  };

  const existing = await findAssistant();
  if (existing) {
    await api(`/ai/assistants/${existing}`, { method: "POST", body });
    console.log(`Assistant updated: ${existing}`);
    return existing;
  }
  const created = await api("/ai/assistants", { method: "POST", body });
  console.log(`Assistant created: ${created.id}`);
  return created.id;
}

async function main() {
  assertEnv("TELNYX_API_KEY", API_KEY);
  console.log("Setting up Bright Smile Dental AI Assistant...\n");

  const mcpServerId = await registerMcpServer();
  const transferToolId = await createTransferTool();
  const assistantId = await createOrUpdateAssistant(mcpServerId, transferToolId);

  console.log("\n=== Setup complete ===");
  console.log(`MCP server:  ${mcpServerId}`);
  console.log(`Transfer:    ${transferToolId}`);
  console.log(`Assistant:   ${assistantId}`);
  console.log("\nPhone assignment:");
  console.log("  1. Portal → Phone Numbers → buy/assign a number");
  console.log("  2. Set the number's AI Assistant to the assistant above");
  console.log(`  3. Or: PUT /v2/ai/assistants/${assistantId}/telephony_settings`);
}

main().catch((err) => {
  console.error("\nSetup failed:", err.message);
  process.exit(1);
});
