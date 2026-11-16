export interface ScenarioSnapshotMessage {
  role: "user" | "assistant" | "tool";
  text?: string;
  tool_calls?: { name: string; arguments: unknown }[];
}

export interface ScenarioAssertion {
  tool_calls: {
    name: string;
    expected: boolean;
    description?: string;
  }[];
  llm_judge_rubric: string;
}

export interface Scenario {
  name: string;
  description: string;
  source_conversation_id?: string;
  replay_user_turns: string[];
  test_turn: string;
  assertions: ScenarioAssertion;
}

export interface EvalResult {
  scenario: string;
  passed: boolean;
  turns_replayed: number;
  test_response: string;
  tool_calls_observed: { name: string; arguments: string }[];
  tool_call_assertions: { name: string; expected: boolean; passed: boolean }[];
  llm_judge: { verdict: "pass" | "fail"; reasoning: string };
  duration_ms: number;
}
