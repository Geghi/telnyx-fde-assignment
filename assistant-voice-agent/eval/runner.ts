import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Scenario, EvalResult } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

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

const API_BASE = "https://api.telnyx.com/v2";
const API_KEY = process.env.TELNYX_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? process.argv[2];
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "moonshotai/Kimi-K2.6";

function assertEnv(name: string, value: string | undefined): asserts value is string {
  if (!value) {
    console.error(`Missing ${name}. Set it in .env.local or pass as arg.`);
    process.exit(1);
  }
}

async function api(path: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function sendChat(assistantId: string, conversationId: string, content: string): Promise<string> {
  const body = await api(`/ai/assistants/${assistantId}/chat`, {
    method: "POST",
    body: { content, conversation_id: conversationId, stream: false },
  });
  return body.content ?? body.data?.content ?? "";
}

async function getConversationMessages(conversationId: string): Promise<any[]> {
  const body = await api(`/ai/conversations/${conversationId}/messages`);
  return (body.data ?? []).slice().reverse();
}

async function createConversation(): Promise<string> {
  const body = await api("/ai/conversations", {
    method: "POST",
    body: { name: `eval-${randomUUID().slice(0, 8)}` },
  });
  return body.id ?? body.data?.id;
}

function extractToolCallsFromMessages(messages: any[], sinceIndex: number): { name: string; arguments: string }[] {
  const toolCalls: { name: string; arguments: string }[] = [];
  for (let i = sinceIndex; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolCalls.push({ name: tc.function.name, arguments: tc.function.arguments });
      }
    }
  }
  return toolCalls;
}

async function llmJudge(rubric: string, response: string): Promise<{ verdict: "pass" | "fail"; reasoning: string }> {
  const judgePrompt = `You are an evaluation judge. You will be given a rubric and an AI assistant's response. Decide if the response satisfies the rubric.

Rubric:
${rubric}

Assistant response:
"""
${response}
"""

Reply with a JSON object only, no other text:
{"verdict": "pass" or "fail", "reasoning": "one sentence explaining your verdict"}`;

  const body = await api("/ai/chat/completions", {
    method: "POST",
    body: {
      model: JUDGE_MODEL,
      messages: [{ role: "user", content: judgePrompt }],
      max_tokens: 200,
      temperature: 0,
      enable_thinking: false,
    },
  });

  const raw = body.choices?.[0]?.message?.content ?? "";
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    return { verdict: "fail", reasoning: `Judge returned no parseable JSON: ${raw.slice(0, 100)}` };
  }
  try {
    return JSON.parse(match[0]);
  } catch {
    return { verdict: "fail", reasoning: `Judge JSON parse failed: ${raw.slice(0, 100)}` };
  }
}

async function runScenario(scenario: Scenario): Promise<EvalResult> {
  const start = Date.now();
  assertEnv("TELNYX_API_KEY", API_KEY);
  assertEnv("ASSISTANT_ID", ASSISTANT_ID);

  const conversationId = await createConversation();

  for (const turn of scenario.replay_user_turns) {
    await sendChat(ASSISTANT_ID, conversationId, turn);
  }

  const messagesBefore = await getConversationMessages(conversationId);
  const beforeIndex = messagesBefore.length;

  const testResponse = await sendChat(ASSISTANT_ID, conversationId, scenario.test_turn);

  const messagesAfter = await getConversationMessages(conversationId);
  const toolCallsObserved = extractToolCallsFromMessages(messagesAfter, 0);

  const toolCallAssertions = scenario.assertions.tool_calls.map((expected) => {
    const found = toolCallsObserved.some((tc) => tc.name === expected.name);
    return { name: expected.name, expected: expected.expected, passed: found === expected.expected };
  });

  const judge = await llmJudge(scenario.assertions.llm_judge_rubric, testResponse);

  const toolCallsAllPass = toolCallAssertions.every((a) => a.passed);
  const judgePass = judge.verdict === "pass";
  const passed = toolCallsAllPass && judgePass;

  return {
    scenario: scenario.name,
    passed,
    turns_replayed: scenario.replay_user_turns.length,
    test_response: testResponse,
    tool_calls_observed: toolCallsObserved,
    tool_call_assertions: toolCallAssertions,
    llm_judge: judge,
    duration_ms: Date.now() - start,
  };
}

async function main() {
  assertEnv("TELNYX_API_KEY", API_KEY);
  if (!ASSISTANT_ID) {
    console.error("Usage: npm run eval <assistant_id> [scenario_name]");
    console.error("Example: npm run eval assistant-c7d08f46-... scenario-a");
    process.exit(1);
  }

  const scenarioFilter = process.argv[3];
  const scenariosDir = resolve(here, "snapshots");
  const scenarioFiles = readdirSync(scenariosDir).filter((f) => f.endsWith(".json"));

  const results: EvalResult[] = [];
  for (const file of scenarioFiles) {
    const scenario = JSON.parse(readFileSync(resolve(scenariosDir, file), "utf8")) as Scenario;
    if (scenarioFilter && !scenario.name.includes(scenarioFilter) && !file.includes(scenarioFilter)) {
      continue;
    }
    console.log(`\nRunning ${scenario.name}...`);
    const result = await runScenario(scenario);
    results.push(result);

    const status = result.passed ? "PASS" : "FAIL";
    console.log(`  ${status} (${result.duration_ms}ms)`);
    console.log(`  Response: ${result.test_response.slice(0, 150)}`);
    console.log(`  Tool calls: ${result.tool_calls_observed.map((t) => `${t.name}(${t.arguments})`).join(", ") || "(none)"}`);
    for (const ta of result.tool_call_assertions) {
      console.log(`    ${ta.passed ? "✓" : "✗"} ${ta.name} (expected=${ta.expected})`);
    }
    console.log(`  LLM judge: ${result.llm_judge.verdict} — ${result.llm_judge.reasoning}`);
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  console.log(`\n=== ${passed}/${results.length} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nEval failed:", err.message);
  process.exit(1);
});
