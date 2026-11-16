import { describe, it, expect } from "vitest";
import { assembleWorkflow } from "../src/assemble-workflow.js";

describe("assembleWorkflow", () => {
  it("substitutes {{PROMPT:<name>}} placeholders with prompt file contents", () => {
    const flow = assembleWorkflow({
      workflowPath: "workflow.json",
      promptsDir: "prompts",
      transferToolId: "tool-transfer-123",
    });

    const greeting = flow.nodes.find((n) => n.id === "n_greeting");
    expect(greeting?.type).toBe("speak");
    expect(greeting?.message).toContain("Thank you for calling Bright Smile Dental");
    expect(greeting?.message).not.toContain("{{PROMPT:");

    const receptionist = flow.nodes.find((n) => n.id === "n_receptionist");
    expect(receptionist?.type).toBe("prompt");
    expect(receptionist?.instructions).toContain("You are Sarah");
    expect(receptionist?.instructions).not.toContain("{{PROMPT:");
  });

  it("substitutes {{TRANSFER_TOOL_ID}} with the provided tool ID", () => {
    const flow = assembleWorkflow({
      workflowPath: "workflow.json",
      promptsDir: "prompts",
      transferToolId: "tool-transfer-abc",
    });

    const transfer = flow.nodes.find((n) => n.id === "n_transfer");
    expect(transfer?.type).toBe("tool");
    expect((transfer as { shared_tool_id: string }).shared_tool_id).toBe("tool-transfer-abc");
  });

  it("preserves all 7 nodes with correct types", () => {
    const flow = assembleWorkflow({
      workflowPath: "workflow.json",
      promptsDir: "prompts",
      transferToolId: "x",
    });

    expect(flow.nodes).toHaveLength(7);
    const types = flow.nodes.map((n) => n.type);
    expect(types.filter((t) => t === "speak")).toHaveLength(3);
    expect(types.filter((t) => t === "prompt")).toHaveLength(3);
    expect(types.filter((t) => t === "tool")).toHaveLength(1);
  });

  it("preserves all 11 edges with correct conditions", () => {
    const flow = assembleWorkflow({
      workflowPath: "workflow.json",
      promptsDir: "prompts",
      transferToolId: "x",
    });

    expect(flow.edges).toHaveLength(11);
    const defaults = flow.edges.filter((e) => e.condition.type === "default");
    expect(defaults).toHaveLength(4);
    const llm = flow.edges.filter((e) => e.condition.type === "llm");
    expect(llm).toHaveLength(7);
  });

  it("preserves start_node_id", () => {
    const flow = assembleWorkflow({
      workflowPath: "workflow.json",
      promptsDir: "prompts",
      transferToolId: "x",
    });
    expect(flow.start_node_id).toBe("n_greeting");
  });

  it("every prompt and speak node has its text filled with no remaining placeholders", () => {
    const flow = assembleWorkflow({
      workflowPath: "workflow.json",
      promptsDir: "prompts",
      transferToolId: "x",
    });

    for (const node of flow.nodes) {
      const text = (node as { instructions?: string; message?: string }).instructions
        ?? (node as { message?: string }).message
        ?? "";
      expect(text).not.toContain("{{PROMPT:");
      expect(text).not.toContain("{{TRANSFER_TOOL_ID}}");
    }
  });

  it("leaves calendar placeholders in the booking prompt when no calendar is passed", () => {
    const flow = assembleWorkflow({
      workflowPath: "workflow.json",
      promptsDir: "prompts",
      transferToolId: "x",
    });
    const booking = flow.nodes.find((n) => n.id === "n_booking");
    expect((booking as { instructions?: string }).instructions).toContain("{{today_date}}");
    expect((booking as { instructions?: string }).instructions).toContain("{{week_snapshot}}");
  });

  it("substitutes calendar placeholders in the booking prompt when calendar is passed", () => {
    const flow = assembleWorkflow({
      workflowPath: "workflow.json",
      promptsDir: "prompts",
      transferToolId: "x",
      calendar: {
        today_date: "2026-11-16",
        weekday: "Mon",
        week_snapshot: "Mon 16, Tue 17, Wed 18, Thu 19, Fri 20, Sat 21, Sun 22",
        current_month: "November",
        next_month: "December",
      },
    });
    const booking = flow.nodes.find((n) => n.id === "n_booking");
    const text = (booking as { instructions?: string }).instructions ?? "";
    expect(text).toContain("TODAY IS Mon, 2026-11-16.");
    expect(text).toContain("This week: Mon 16, Tue 17, Wed 18, Thu 19, Fri 20, Sat 21, Sun 22.");
    expect(text).toContain("Current month: November. Next month: December.");
    expect(text).not.toContain("{{today_date}}");
    expect(text).not.toContain("{{week_snapshot}}");
    expect(text).not.toContain("{{current_month}}");
    expect(text).not.toContain("{{next_month}}");
    expect(text).not.toContain("{{weekday}}");
  });
});
