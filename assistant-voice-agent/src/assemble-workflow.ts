import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CalendarSnapshot } from "./calendar.js";

const here = dirname(fileURLToPath(import.meta.url));

export type NodeType = "prompt" | "speak" | "tool";

export interface FlowNode {
  type: NodeType;
  id: string;
  name?: string;
  instructions?: string;
  instructions_mode?: "replace" | "append";
  message?: string;
  shared_tool_id?: string;
  shared_tool_ids?: string[];
  tools_mode?: "replace" | "append";
  position?: { x: number; y: number };
}

export interface FlowEdgeCondition {
  type: "llm" | "expression" | "default";
  prompt?: string;
  /** Deterministic check, e.g. {type: "comparison", op: "==", left: {type: "variable", name}, right: {type: "string_literal", value}}. */
  expression?: unknown;
}

export interface FlowEdge {
  id: string;
  start_node_id: string;
  target: { type: "node" | "assistant"; node_id?: string; assistant_id?: string };
  condition: FlowEdgeCondition;
}

export interface ConversationFlow {
  start_node_id: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export function assembleWorkflow(args: {
  workflowPath: string;
  promptsDir: string;
  transferToolId: string;
  /** Shared tool ids by name, resolving `{{TOOL:<name>}}` in `shared_tool_ids`. */
  toolIds?: Record<string, string>;
  calendar?: CalendarSnapshot;
}): ConversationFlow {
  const root = resolve(here, "..");
  const raw = JSON.parse(readFileSync(resolve(root, args.workflowPath), "utf8"));

  const promptFiles = readdirSync(resolve(root, args.promptsDir));
  const prompts = new Map<string, string>();
  for (const f of promptFiles) {
    if (f.endsWith(".txt")) {
      const name = f.replace(/\.txt$/, "");
      prompts.set(name, readFileSync(resolve(root, args.promptsDir, f), "utf8").trim());
    }
  }

  const calendar = args.calendar;
  const replacePlaceholders = (text: string): string => {
    let out = text.replace(/\{\{PROMPT:([\w-]+)\}\}/g, (_, name) => prompts.get(name) ?? "")
                  .replace(/\{\{TRANSFER_TOOL_ID\}\}/g, args.transferToolId);
    if (calendar) {
      out = out
        .replace(/\{\{today_date\}\}/g, calendar.today_date)
        .replace(/\{\{weekday\}\}/g, calendar.weekday)
        .replace(/\{\{week_snapshot\}\}/g, calendar.week_snapshot)
        .replace(/\{\{current_month\}\}/g, calendar.current_month)
        .replace(/\{\{next_month\}\}/g, calendar.next_month);
    }
    return out;
  };

  const nodes: FlowNode[] = raw.nodes.map((n: FlowNode) => {
    const node: FlowNode = { ...n };
    if (node.instructions) node.instructions = replacePlaceholders(node.instructions);
    if (node.message) node.message = replacePlaceholders(node.message);
    if (node.shared_tool_id) node.shared_tool_id = replacePlaceholders(node.shared_tool_id);
    if (node.shared_tool_ids && args.toolIds) {
      node.shared_tool_ids = node.shared_tool_ids.map((ref) => resolveToolRef(ref, args.toolIds!, node.id));
    }
    return node;
  });

  return {
    start_node_id: raw.start_node_id,
    nodes,
    edges: raw.edges,
  };
}

function resolveToolRef(ref: string, toolIds: Record<string, string>, nodeId: string): string {
  const m = ref.match(/^\{\{TOOL:([\w-]+)\}\}$/);
  if (!m) return ref;
  const id = toolIds[m[1]];
  if (!id) throw new Error(`Node ${nodeId} references tool "${m[1]}" but no id was provided for it`);
  return id;
}
