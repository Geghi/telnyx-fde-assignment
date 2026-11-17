import { describe, it, expect } from "vitest";
import { latestConversationId } from "../src/latest-conversation.js";

describe("latestConversationId", () => {
  it("picks the conversation with the most recent activity", () => {
    expect(
      latestConversationId([
        { id: "old", created_at: "2026-11-17T09:00:00Z", last_message_at: "2026-11-17T09:05:00Z" },
        { id: "new", created_at: "2026-11-17T08:00:00Z", last_message_at: "2026-11-17T10:00:00Z" },
      ])
    ).toBe("new");
  });

  it("falls back to created_at when there is no message yet", () => {
    expect(
      latestConversationId([
        { id: "a", created_at: "2026-11-17T09:00:00Z" },
        { id: "b", created_at: "2026-11-17T11:00:00Z" },
      ])
    ).toBe("b");
  });

  it("returns null when there are no conversations", () => {
    expect(latestConversationId([])).toBeNull();
  });
});
