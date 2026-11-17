import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { latestConversationId } from "./src/latest-conversation.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function loadEnvFile() {
  try {
    const content = readFileSync(resolve(repoRoot, ".env.local"), "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const m = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) {
        let value = m[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!process.env[m[1]]) process.env[m[1]] = value;
      }
    }
  } catch {
    // env may already be set
  }
}
loadEnvFile();

const API_KEY = process.env.TELNYX_API_KEY;
const API_BASE = "https://api.telnyx.com/v2";

if (!API_KEY) {
  console.error("Missing TELNYX_API_KEY in .env.local");
  process.exit(1);
}

/** No id given: trace the newest conversation of ASSISTANT_ID (or of the account). */
async function findLatestConversation(): Promise<string> {
  const assistantId = process.env.ASSISTANT_ID;
  const filter = assistantId ? `&metadata-%3Eassistant_id=eq.${encodeURIComponent(assistantId)}` : "";
  const res = await fetch(`${API_BASE}/ai/conversations?page%5Bsize%5D=20${filter}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  const id = latestConversationId((await res.json()).data ?? []);
  if (!res.ok || !id) {
    console.error(`No conversation found (HTTP ${res.status}).`);
    process.exit(1);
  }
  return id;
}

const CONVERSATION_ID = process.argv[2] ?? (await findLatestConversation());

const res = await fetch(
  `${API_BASE}/ai/conversations/${CONVERSATION_ID}/messages?page%5Bsize%5D=100`,
  { headers: { Authorization: `Bearer ${API_KEY}` } }
);
const text = await res.text();
if (!res.ok) {
  console.error(`Error ${res.status}: ${text.slice(0, 300)}`);
  process.exit(1);
}

const body = JSON.parse(text);
const messages = body.data ?? [];

const metaRes = await fetch(
  `${API_BASE}/ai/conversations/${CONVERSATION_ID}`,
  { headers: { Authorization: `Bearer ${API_KEY}` } }
);
const metaBody = await metaRes.json();
const meta = (metaBody.data ?? {}).metadata ?? {};

console.log(`Conversation: ${CONVERSATION_ID}`);
console.log(`Channel: ${meta.telnyx_conversation_channel ?? "unknown"}`);
if (Array.isArray(meta.flow_transitions) && meta.flow_transitions.length > 0) {
  console.log(`Flow transitions:`);
  for (const t of meta.flow_transitions) console.log(`  ${t}`);
}
console.log(`${messages.length} messages\n`);
console.log("=".repeat(70));

for (const msg of messages) {
  const time = msg.sent_at ?? msg.created_at ?? "?";
  const t = time.slice(11, 19);
  const role = msg.role.padEnd(10);
  let line = `[${t}] ${role}`;

  if (msg.text) {
    line += msg.text.slice(0, 200);
    if (msg.text.length > 200) line += "...";
  }

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      const args = JSON.parse(tc.function.arguments);
      const argsStr = Object.entries(args)
        .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
        .join(", ");
      console.log(`${line}→ TOOL CALL: ${tc.function.name}(${argsStr})`);
    }
  } else if (msg.role === "tool") {
    const content = msg.text ?? "";
    console.log(`${line}← TOOL RESULT: ${content.slice(0, 300)}`);
  } else {
    console.log(line);
  }
}
console.log("=".repeat(70));
