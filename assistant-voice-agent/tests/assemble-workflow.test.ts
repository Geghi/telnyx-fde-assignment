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

  it("preserves all 9 nodes with correct types", () => {
    const flow = assembleWorkflow({
      workflowPath: "workflow.json",
      promptsDir: "prompts",
      transferToolId: "x",
    });

    expect(flow.nodes).toHaveLength(9);
    const types = flow.nodes.map((n) => n.type);
    expect(types.filter((t) => t === "speak")).toHaveLength(3);
    expect(types.filter((t) => t === "prompt")).toHaveLength(5);
    expect(types.filter((t) => t === "tool")).toHaveLength(1);
  });

  it("preserves all 15 edges with correct conditions", () => {
    const flow = assembleWorkflow({
      workflowPath: "workflow.json",
      promptsDir: "prompts",
      transferToolId: "x",
    });

    expect(flow.edges).toHaveLength(15);
    const defaults = flow.edges.filter((e) => e.condition.type === "default");
    expect(defaults).toHaveLength(4);
    const llm = flow.edges.filter((e) => e.condition.type === "llm");
    expect(llm).toHaveLength(10);
    expect(flow.edges.filter((e) => e.condition.type === "expression")).toHaveLength(1);
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

  describe("per-node tool scoping", () => {
    const toolIds = {
      update_booking_draft: "tool-draft",
      get_booking_status: "tool-status",
      book_appointment: "tool-book",
      save_booking_request: "tool-request",
      get_appointment: "tool-lookup",
      cancel_appointment: "tool-cancel",
    };
    const flow = assembleWorkflow({
      workflowPath: "workflow.json",
      promptsDir: "prompts",
      transferToolId: "x",
      toolIds,
    });
    const node = (id: string) =>
      flow.nodes.find((n) => n.id === id) as { shared_tool_ids?: string[]; tools_mode?: string };

    it("gives Booking only the booking write tools, appended to the MCP read tools", () => {
      expect(node("n_booking").shared_tool_ids).toEqual(["tool-draft", "tool-status", "tool-book"]);
      expect(node("n_booking").tools_mode).toBe("append");
    });

    it("gives Booking request the draft tools and save_booking_request, never book_appointment", () => {
      expect(node("n_booking_request").shared_tool_ids).toEqual(["tool-draft", "tool-status", "tool-request"]);
      expect(node("n_booking_request").tools_mode).toBe("append");
    });

    it("gives Cancellation the lookup and cancel, appended to the MCP read tools", () => {
      expect(node("n_cancellation").shared_tool_ids).toEqual(["tool-lookup", "tool-cancel"]);
      expect(node("n_cancellation").tools_mode).toBe("append");
    });

    it("gives Receptionist only the read-only appointment lookup", () => {
      expect(node("n_receptionist").shared_tool_ids).toEqual(["tool-lookup"]);
      expect(node("n_receptionist").tools_mode).toBe("append");
    });

    it("gives Confirmation no shared tools", () => {
      expect(node("n_confirmation").shared_tool_ids).toBeUndefined();
    });

    it("throws when workflow.json references a tool with no id", () => {
      expect(() =>
        assembleWorkflow({
          workflowPath: "workflow.json",
          promptsDir: "prompts",
          transferToolId: "x",
          toolIds: { update_booking_draft: "a" },
        })
      ).toThrow(/references tool "get_appointment" but no id/);
    });
  });

  describe("online booking disabled → callback request path", () => {
    const flow = assembleWorkflow({ workflowPath: "workflow.json", promptsDir: "prompts", transferToolId: "x" });
    const edge = (from: string, to: string) =>
      flow.edges.find((e) => e.start_node_id === from && e.target.node_id === to);

    it("routes Booking → Booking request on a variable comparison of online_booking_enabled", () => {
      expect(edge("n_booking", "n_booking_request")?.condition).toEqual({
        type: "expression",
        expression: {
          type: "comparison",
          op: "==",
          left: { type: "variable", name: "online_booking_enabled" },
          right: { type: "string_literal", value: "false" },
        },
      });
    });

    it("confirms a saved request with a verbatim callback promise, then returns to Receptionist", () => {
      const speak = flow.nodes.find((n) => n.id === "n_callback_confirmation");
      expect(speak?.type).toBe("speak");
      expect(speak?.message?.toLowerCase()).toContain("call you back");
      expect(edge("n_booking_request", "n_callback_confirmation")?.condition.type).toBe("llm");
      expect(edge("n_callback_confirmation", "n_receptionist")?.condition.type).toBe("default");
    });

    it("lets the caller abandon the request back to Receptionist", () => {
      expect(edge("n_booking_request", "n_receptionist")?.condition.type).toBe("llm");
    });
  });
});
