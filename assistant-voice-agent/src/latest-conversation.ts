export interface ConversationSummary {
  id: string;
  created_at?: string;
  last_message_at?: string;
}

export function latestConversationId(conversations: ConversationSummary[]): string | null {
  const activity = (c: ConversationSummary) => c.last_message_at ?? c.created_at ?? "";
  const latest = [...conversations].sort((a, b) => activity(b).localeCompare(activity(a)))[0];
  return latest?.id ?? null;
}
