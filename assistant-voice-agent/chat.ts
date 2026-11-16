import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";

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

const ASSISTANT_ID = process.argv[2];
const API_KEY = process.env.TELNYX_API_KEY;
const API_BASE = "https://api.telnyx.com/v2";

if (!ASSISTANT_ID) {
  console.error("Usage: npm run chat <assistant_id>");
  console.error("Example: npm run chat assistant-c7d08f46-...");
  process.exit(1);
}
if (!API_KEY) {
  console.error("Missing TELNYX_API_KEY in .env.local");
  process.exit(1);
}

const conversationId = randomUUID();
console.log(`Chat with assistant ${ASSISTANT_ID}`);
console.log(`Creating conversation...`);

const createRes = await fetch(`${API_BASE}/ai/conversations`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ name: `chat-${conversationId.slice(0, 8)}` }),
});
const createText = await createRes.text();
if (!createRes.ok) {
  console.error(`Failed to create conversation: ${createRes.status}: ${createText.slice(0, 300)}`);
  process.exit(1);
}
const conv = JSON.parse(createText);
const convId = conv.id ?? conv.data?.id;
if (!convId) {
  console.error(`Could not find conversation id in response: ${createText.slice(0, 300)}`);
  process.exit(1);
}
console.log(`Conversation: ${convId}`);
console.log(`Type your messages. Ctrl-C to quit.\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout });

while (true) {
  const userMsg = await rl.question("you> ");
  if (!userMsg.trim()) continue;

  const res = await fetch(`${API_BASE}/ai/assistants/${ASSISTANT_ID}/chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: userMsg,
      conversation_id: convId,
      stream: false,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`Error ${res.status}: ${text.slice(0, 300)}`);
    continue;
  }

  const body = JSON.parse(text);
  const reply = body.data?.content ?? body.content ?? JSON.stringify(body, null, 2);
  console.log(`sarah> ${reply}\n`);
}
