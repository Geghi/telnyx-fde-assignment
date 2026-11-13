export interface WebhookPayload {
  data: {
    event_type: string;
    payload: {
      telnyx_conversation_channel: string;
      telnyx_agent_target: string;
      telnyx_end_user_target: string;
      telnyx_end_user_target_verified?: boolean;
      call_control_id: string;
      assistant_id: string;
    };
  };
}

export interface DynamicVariablesResponse {
  dynamic_variables: Record<string, string>;
}

export interface CallSessionState {
  callerName: string | null;
  lastBookingId: string | null;
  totalCalls: number;
}

export interface Metrics {
  webhookCalls: number;
  webhookErrors: number;
}

export interface Env {
  CLINIC_KV: {
    get(key: string): Promise<string | null>;
    get<T>(key: string, options: { type: "json" }): Promise<T | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
    delete(key: string): Promise<void>;
    list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
      keys: { name: string; sizeBytes: number; updatedAt: string }[];
      list_complete: boolean;
      cursor?: string;
    }>;
  };
  CALL_SESSION: {
    idFromName(name: string): CallSessionStub;
  };
}

export interface CallSessionStub {
  getOrCreate(): Promise<CallSessionState>;
  updateCallerName(name: string): Promise<void>;
  recordCall(): Promise<{ totalCalls: number }>;
  setLastBooking(bookingId: string): Promise<void>;
}
