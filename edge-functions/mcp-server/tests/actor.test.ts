import { describe, it, expect, beforeEach } from "vitest";
import { BookingActor } from "../src/actor.js";
import type { BookingActorState } from "../src/actor.js";

type Storage = {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown): Promise<void>;
};

function createActorWithStorage(storage: Map<string, unknown>): BookingActor {
  const fakeStorage: Storage = {
    get: async (key: string) => (storage.get(key) ?? null) as unknown as Promise<any>,
    put: async (key: string, value: unknown) => { storage.set(key, value); },
  };
  const actor = Object.create(BookingActor.prototype) as BookingActor;
  Object.assign(actor, { ctx: { storage: fakeStorage } });
  return actor;
}

describe("BookingActor", () => {
  let storage: Map<string, unknown>;
  let actor: BookingActor;

  beforeEach(() => {
    storage = new Map();
    actor = createActorWithStorage(storage);
  });

  describe("getDraft", () => {
    it("returns null when storage is empty", async () => {
      const draft = await actor.getDraft();
      expect(draft).toBeNull();
    });

    it("returns the stored draft when one exists", async () => {
      const state: BookingActorState = {
        draft: { reason: "cleaning", preferredDate: null, slot: null, name: null },
        booking: null,
        bookingCounter: 0,
      };
      storage.set("state", state);
      const draft = await actor.getDraft();
      expect(draft?.reason).toBe("cleaning");
    });
  });

  describe("updateDraft — read-modify-write", () => {
    it("creates a fresh draft when none exists", async () => {
      const draft = await actor.updateDraft("reason", "cleaning");
      expect(draft.reason).toBe("cleaning");
      expect(draft.preferredDate).toBeNull();
    });

    it("persists the update to storage", async () => {
      await actor.updateDraft("reason", "cleaning");
      const stored = storage.get("state") as BookingActorState;
      expect(stored.draft?.reason).toBe("cleaning");
    });

    it("accumulates fields across sequential calls", async () => {
      await actor.updateDraft("reason", "cleaning");
      await actor.updateDraft("preferredDate", "2026-11-16");
      await actor.updateDraft("slot", {
        date: "2026-11-16",
        time: "09:00",
        dentist: "Dr. Lee",
      });
      await actor.updateDraft("name", "John");
      const draft = await actor.getDraft();
      expect(draft?.reason).toBe("cleaning");
      expect(draft?.preferredDate).toBe("2026-11-16");
      expect(draft?.slot?.time).toBe("09:00");
      expect(draft?.name).toBe("John");
    });

    it("overwrites a field when the same field is updated again", async () => {
      await actor.updateDraft("reason", "cleaning");
      const draft = await actor.updateDraft("reason", "root canal");
      expect(draft.reason).toBe("root canal");
    });
  });

  describe("getDraftStatus", () => {
    it("returns ask_reason with all fields missing for a fresh conversation", async () => {
      const status = await actor.getDraftStatus();
      expect(status.nextStep).toBe("ask_reason");
      expect(status.missingFields).toEqual([
        "reason",
        "preferredDate",
        "slot",
        "name",
      ]);
    });

    it("returns ask_preferred_date after reason is set", async () => {
      await actor.updateDraft("reason", "cleaning");
      const status = await actor.getDraftStatus();
      expect(status.nextStep).toBe("ask_preferred_date");
      expect(status.missingFields).not.toContain("reason");
    });

    it("returns book when all fields are set", async () => {
      await actor.updateDraft("reason", "cleaning");
      await actor.updateDraft("preferredDate", "2026-11-16");
      await actor.updateDraft("slot", {
        date: "2026-11-16",
        time: "09:00",
        dentist: "Dr. Lee",
      });
      await actor.updateDraft("name", "John");
      const status = await actor.getDraftStatus();
      expect(status.nextStep).toBe("book");
      expect(status.missingFields).toEqual([]);
    });
  });

  describe("createBooking", () => {
    it("throws when draft is missing required fields", async () => {
      await actor.updateDraft("reason", "cleaning");
      await expect(
        actor.createBooking({ callerPhone: "+15551234567" })
      ).rejects.toThrow(/Missing required fields/);
    });

    it("creates a booking from a complete draft and returns the confirmation", async () => {
      await actor.updateDraft("reason", "cleaning");
      await actor.updateDraft("preferredDate", "2026-11-16");
      await actor.updateDraft("slot", {
        date: "2026-11-16",
        time: "09:00",
        dentist: "Dr. Lee",
      });
      await actor.updateDraft("name", "John");
      const booking = await actor.createBooking({
        callerPhone: "+15551234567",
      });
      expect(booking.bookingId).toBe("BK-0001");
      expect(booking.date).toBe("2026-11-16");
      expect(booking.time).toBe("09:00");
      expect(booking.dentist).toBe("Dr. Lee");
      expect(booking.confirmed).toBe(true);
    });

    it("clears the draft after booking", async () => {
      await actor.updateDraft("reason", "cleaning");
      await actor.updateDraft("slot", {
        date: "2026-11-16",
        time: "09:00",
        dentist: "Dr. Lee",
      });
      await actor.updateDraft("name", "John");
      await actor.createBooking({ callerPhone: "+15551234567" });
      expect(await actor.getDraft()).toBeNull();
    });

    it("increments bookingCounter across successive bookings", async () => {
      await actor.updateDraft("reason", "cleaning");
      await actor.updateDraft("slot", {
        date: "2026-11-16",
        time: "09:00",
        dentist: "Dr. Lee",
      });
      await actor.updateDraft("name", "John");
      const first = await actor.createBooking({ callerPhone: "+15551234567" });
      expect(first.bookingId).toBe("BK-0001");

      await actor.updateDraft("reason", "whitening");
      await actor.updateDraft("slot", {
        date: "2026-11-17",
        time: "10:00",
        dentist: "Dr. Patel",
      });
      await actor.updateDraft("name", "John");
      const second = await actor.createBooking({ callerPhone: "+15551234567" });
      expect(second.bookingId).toBe("BK-0002");
    });
  });

  describe("cancelBooking", () => {
    it("returns cancelled=false when no booking exists", async () => {
      const result = await actor.cancelBooking();
      expect(result.cancelled).toBe(false);
      expect(result.reason).toContain("no booking");
    });

    it("cancels an existing booking and returns the date", async () => {
      await actor.updateDraft("reason", "cleaning");
      await actor.updateDraft("slot", {
        date: "2026-11-16",
        time: "09:00",
        dentist: "Dr. Lee",
      });
      await actor.updateDraft("name", "John");
      await actor.createBooking({ callerPhone: "+15551234567" });
      const result = await actor.cancelBooking();
      expect(result.cancelled).toBe(true);
      expect(result.date).toBe("2026-11-16");
    });

    it("clears the booking in storage", async () => {
      await actor.updateDraft("reason", "cleaning");
      await actor.updateDraft("slot", {
        date: "2026-11-16",
        time: "09:00",
        dentist: "Dr. Lee",
      });
      await actor.updateDraft("name", "John");
      await actor.createBooking({ callerPhone: "+15551234567" });
      await actor.cancelBooking();
      const stored = storage.get("state") as BookingActorState;
      expect(stored.booking).toBeNull();
    });
  });

  describe("getBookedSlotForDate", () => {
    it("returns null when no booking exists", async () => {
      const slot = await actor.getBookedSlotForDate("2026-11-16");
      expect(slot).toBeNull();
    });

    it("returns the slot when the booking falls on the requested date", async () => {
      await actor.updateDraft("reason", "cleaning");
      await actor.updateDraft("slot", {
        date: "2026-11-16",
        time: "09:00",
        dentist: "Dr. Lee",
      });
      await actor.updateDraft("name", "John");
      await actor.createBooking({ callerPhone: "+15551234567" });
      const slot = await actor.getBookedSlotForDate("2026-11-16");
      expect(slot?.time).toBe("09:00");
    });

    it("returns null when the booking is on a different date", async () => {
      await actor.updateDraft("reason", "cleaning");
      await actor.updateDraft("slot", {
        date: "2026-11-16",
        time: "09:00",
        dentist: "Dr. Lee",
      });
      await actor.updateDraft("name", "John");
      await actor.createBooking({ callerPhone: "+15551234567" });
      const slot = await actor.getBookedSlotForDate("2026-12-02");
      expect(slot).toBeNull();
    });

    it("returns null after the booking is cancelled", async () => {
      await actor.updateDraft("reason", "cleaning");
      await actor.updateDraft("slot", {
        date: "2026-11-16",
        time: "09:00",
        dentist: "Dr. Lee",
      });
      await actor.updateDraft("name", "John");
      await actor.createBooking({ callerPhone: "+15551234567" });
      await actor.cancelBooking();
      const slot = await actor.getBookedSlotForDate("2026-11-16");
      expect(slot).toBeNull();
    });
  });
});
