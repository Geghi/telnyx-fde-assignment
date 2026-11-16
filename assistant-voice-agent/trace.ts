import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

const CONVERSATION_ID = process.argv[2];
const API_KEY = process.env.TELNYX_API_KEY;
const API_BASE = "https://api.telnyx.com/v2";

if (!CONVERSATION_ID) {
  console.error("Usage: npm run trace <conversation_id>");
  console.error("Example: npm run trace 5d72fb92-d719-4c51-992f-820beb1484ed");
  process.exit(1);
}
if (!API_KEY) {
  console.error("Missing TELNYX_API_KEY in .env.local");
  process.exit(1);
}

const res = await fetch(
  `${API_BASE}/ai/conversations/${CONVERSATION_ID}/messages`,
  { headers: { Authorization: `Bearer ${API_KEY}` } }
);
const text = await res.text();
if (!res.ok) {
  console.error(`Error ${res.status}: ${text.slice(0, 300)}`);
  process.exit(1);
}

const body = JSON.parse(text);
const messages = body.data ?? [];

console.log(`Conversation: ${CONVERSATION_ID}`);
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
