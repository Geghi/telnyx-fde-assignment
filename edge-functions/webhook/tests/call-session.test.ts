import { describe, it, expect, beforeEach } from "vitest";
import { CallSession } from "../src/actor/call-session.js";
import type { CallSessionState } from "../src/types.js";

type Storage = {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown): Promise<void>;
};

function createCallSessionWithStorage(storage: Map<string, unknown>): CallSession {
  const fakeStorage: Storage = {
    get: async (key: string) => (storage.get(key) ?? null) as unknown as Promise<any>,
    put: async (key: string, value: unknown) => { storage.set(key, value); },
  };
  const session = Object.create(CallSession.prototype) as CallSession;
  Object.assign(session, { ctx: { storage: fakeStorage } });
  return session;
}

describe("CallSession actor", () => {
  let storage: Map<string, unknown>;
  let session: CallSession;

  beforeEach(() => {
    storage = new Map();
    session = createCallSessionWithStorage(storage);
  });

  describe("getOrCreate", () => {
    it("returns a fresh session state when storage is empty", async () => {
      const state = await session.getOrCreate();
      expect(state).toEqual({
        callerName: null,
        lastBookingId: null,
        totalCalls: 0,
      });
    });

    it("persists the fresh state to storage on first access", async () => {
      await session.getOrCreate();
      expect(storage.get("session")).toEqual({
        callerName: null,
        lastBookingId: null,
        totalCalls: 0,
      });
    });

    it("returns the existing state when one is already stored", async () => {
      const existing: CallSessionState = {
        callerName: "John",
        lastBookingId: "BK-0001",
        totalCalls: 4,
      };
      storage.set("session", existing);
      const state = await session.getOrCreate();
      expect(state).toEqual(existing);
    });
  });

  describe("recordCall — read-modify-write", () => {
    it("increments totalCalls from 0 to 1 on a fresh session", async () => {
      const result = await session.recordCall();
      expect(result).toEqual({ totalCalls: 1 });
      const stored = storage.get("session") as CallSessionState;
      expect(stored.totalCalls).toBe(1);
    });

    it("preserves other fields when incrementing totalCalls", async () => {
      storage.set("session", {
        callerName: "John",
        lastBookingId: "BK-0001",
        totalCalls: 4,
      });
      const result = await session.recordCall();
      expect(result).toEqual({ totalCalls: 5 });
      const stored = storage.get("session") as CallSessionState;
      expect(stored).toEqual({
        callerName: "John",
        lastBookingId: "BK-0001",
        totalCalls: 5,
      });
    });

    it("each recordCall is a read-modify-write (sequential calls accumulate)", async () => {
      await session.recordCall();
      await session.recordCall();
      await session.recordCall();
      const stored = storage.get("session") as CallSessionState;
      expect(stored.totalCalls).toBe(3);
    });
  });

  describe("updateCallerName", () => {
    it("writes the name without touching other fields", async () => {
      storage.set("session", {
        callerName: null,
        lastBookingId: "BK-0001",
        totalCalls: 2,
      });
      await session.updateCallerName("Alice");
      const stored = storage.get("session") as CallSessionState;
      expect(stored.callerName).toBe("Alice");
      expect(stored.lastBookingId).toBe("BK-0001");
      expect(stored.totalCalls).toBe(2);
    });
  });

  describe("setLastBooking", () => {
    it("writes the booking id without touching other fields", async () => {
      storage.set("session", {
        callerName: "John",
        lastBookingId: null,
        totalCalls: 1,
      });
      await session.setLastBooking("BK-0042");
      const stored = storage.get("session") as CallSessionState;
      expect(stored.lastBookingId).toBe("BK-0042");
      expect(stored.callerName).toBe("John");
      expect(stored.totalCalls).toBe(1);
    });
  });
});
