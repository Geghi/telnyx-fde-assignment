import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/index.js";

describe("Store", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store();
  });

  describe("business info", () => {
    it("returns clinic hours, location and policies", () => {
      const info = store.getBusinessInfo();
      expect(info.name).toBe("Bright Smile Dental");
      expect(info.hours).toContain("Mon-Fri");
      expect(info.location).toBeDefined();
      expect(info.phone).toBeDefined();
    });
  });

  describe("services", () => {
    it("returns a list of services with prices", () => {
      const services = store.getServices();
      expect(services.length).toBeGreaterThanOrEqual(3);
      expect(services[0].name).toBeDefined();
      expect(services[0].price).toBeDefined();
      expect(services[0].description).toBeDefined();
    });
  });

  describe("availability", () => {
    it("returns slots for a given date", () => {
      const slots = store.checkAvailability("2026-11-16");
      expect(slots.length).toBeGreaterThan(0);
      expect(slots[0].date).toBe("2026-11-16");
      expect(slots[0].time).toBeDefined();
      expect(slots[0].dentist).toBeDefined();
    });

    it("returns empty for a Sunday (clinic closed)", () => {
      const slots = store.checkAvailability("2026-11-15");
      expect(slots).toEqual([]);
    });

    it("excludes already booked slots", () => {
      store.createBooking({
        callerPhone: "+15551234567",
        name: "John",
        slot: { date: "2026-11-16", time: "09:00", dentist: "Dr. Lee" },
        reason: "cleaning",
      });
      const slots = store.checkAvailability("2026-11-16");
      expect(slots.find((s) => s.time === "09:00")).toBeUndefined();
    });
  });

  describe("booking draft", () => {
    it("starts empty for a new caller", () => {
      const draft = store.getDraft("+15551234567");
      expect(draft).toBeNull();
    });

    it("saves a field and returns the updated draft", () => {
      const draft = store.updateDraft("+15551234567", "reason", "cleaning");
      expect(draft.reason).toBe("cleaning");
      expect(draft.preferredDate).toBeNull();
    });

    it("overwrites a field when caller corrects", () => {
      store.updateDraft("+15551234567", "reason", "cleaning");
      const draft = store.updateDraft("+15551234567", "reason", "root canal");
      expect(draft.reason).toBe("root canal");
    });

    it("accumulates fields across calls", () => {
      store.updateDraft("+15551234567", "reason", "cleaning");
      store.updateDraft("+15551234567", "preferredDate", "2026-11-16");
      store.updateDraft("+15551234567", "slot", { date: "2026-11-16", time: "09:00", dentist: "Dr. Lee" });
      store.updateDraft("+15551234567", "name", "John");
      const draft = store.getDraft("+15551234567");
      expect(draft.reason).toBe("cleaning");
      expect(draft.preferredDate).toBe("2026-11-16");
      expect(draft.slot.time).toBe("09:00");
      expect(draft.name).toBe("John");
    });

    it("isolates drafts per caller", () => {
      store.updateDraft("+15551234567", "reason", "cleaning");
      store.updateDraft("+19998887777", "reason", "checkup");
      expect(store.getDraft("+15551234567").reason).toBe("cleaning");
      expect(store.getDraft("+19998887777").reason).toBe("checkup");
    });
  });

  describe("create booking from draft", () => {
    it("creates a booking and returns confirmation", () => {
      store.updateDraft("+15551234567", "reason", "cleaning");
      store.updateDraft("+15551234567", "slot", { date: "2026-11-16", time: "09:00", dentist: "Dr. Lee" });
      store.updateDraft("+15551234567", "name", "John");
      const booking = store.createBooking({ callerPhone: "+15551234567" });
      expect(booking.bookingId).toBeDefined();
      expect(booking.date).toBe("2026-11-16");
      expect(booking.time).toBe("09:00");
      expect(booking.dentist).toBe("Dr. Lee");
      expect(booking.confirmed).toBe(true);
    });

    it("clears the draft after booking", () => {
      store.updateDraft("+15551234567", "reason", "cleaning");
      store.updateDraft("+15551234567", "slot", { date: "2026-11-16", time: "09:00", dentist: "Dr. Lee" });
      store.updateDraft("+15551234567", "name", "John");
      store.createBooking({ callerPhone: "+15551234567" });
      expect(store.getDraft("+15551234567")).toBeNull();
    });

    it("throws if draft is missing required fields", () => {
      store.updateDraft("+15551234567", "reason", "cleaning");
      expect(() => store.createBooking({ callerPhone: "+15551234567" })).toThrow();
    });
  });

  describe("cancel booking", () => {
    it("cancels an existing booking by phone", () => {
      store.updateDraft("+15551234567", "reason", "cleaning");
      store.updateDraft("+15551234567", "slot", { date: "2026-11-16", time: "09:00", dentist: "Dr. Lee" });
      store.updateDraft("+15551234567", "name", "John");
      const booking = store.createBooking({ callerPhone: "+15551234567" });
      const result = store.cancelBooking("+15551234567");
      expect(result.cancelled).toBe(true);
      expect(result.date).toBe("2026-11-16");
    });

    it("returns not found for a caller with no booking", () => {
      const result = store.cancelBooking("+19998887777");
      expect(result.cancelled).toBe(false);
      expect(result.reason).toContain("no booking");
    });
  });

  describe("draft status", () => {
    it("returns next_step and missing_fields for a partial draft", () => {
      store.updateDraft("+15551234567", "reason", "cleaning");
      const status = store.getDraftStatus("+15551234567");
      expect(status.nextStep).toBe("ask_preferred_date");
      expect(status.missingFields).toContain("preferredDate");
      expect(status.missingFields).toContain("slot");
      expect(status.missingFields).toContain("name");
    });

    it("returns next_step=search_slots when date is set", () => {
      store.updateDraft("+15551234567", "reason", "cleaning");
      store.updateDraft("+15551234567", "preferredDate", "2026-11-16");
      const status = store.getDraftStatus("+15551234567");
      expect(status.nextStep).toBe("search_slots");
      expect(status.missingFields).toContain("slot");
    });

    it("returns next_step=ask_name when slot is set", () => {
      store.updateDraft("+15551234567", "reason", "cleaning");
      store.updateDraft("+15551234567", "preferredDate", "2026-11-16");
      store.updateDraft("+15551234567", "slot", { date: "2026-11-16", time: "09:00", dentist: "Dr. Lee" });
      const status = store.getDraftStatus("+15551234567");
      expect(status.nextStep).toBe("ask_name");
      expect(status.missingFields).toContain("name");
    });

    it("returns next_step=book when all fields are set", () => {
      store.updateDraft("+15551234567", "reason", "cleaning");
      store.updateDraft("+15551234567", "preferredDate", "2026-11-16");
      store.updateDraft("+15551234567", "slot", { date: "2026-11-16", time: "09:00", dentist: "Dr. Lee" });
      store.updateDraft("+15551234567", "name", "John");
      const status = store.getDraftStatus("+15551234567");
      expect(status.nextStep).toBe("book");
      expect(status.missingFields).toEqual([]);
    });

    it("returns next_step=ask_reason for a new caller", () => {
      const status = store.getDraftStatus("+15551234567");
      expect(status.nextStep).toBe("ask_reason");
      expect(status.missingFields).toContain("reason");
    });
  });
});
