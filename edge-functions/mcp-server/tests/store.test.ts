import { describe, it, expect, beforeEach, vi } from "vitest";
import { Store, BUSINESS_INFO_KV_KEY } from "../src/store/index.js";

describe("Store", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store();
  });

  describe("KV config loading", () => {
    it("uses default business info when KV is empty", async () => {
      const kv = { get: async () => null };
      await store.initFromKv(kv);
      expect(store.isInitialized).toBe(true);
      expect(store.getBusinessInfo().name).toBe("Bright Smile Dental");
      expect(store.getBusinessInfo().hours).toContain("Mon-Fri");
    });

    it("loads business info + services from KV when present", async () => {
      const expectedInfo = {
        name: "Springfield Smiles",
        hours: "Tue-Sat 9am-5pm",
        location: "456 First St, Springfield, IL 62701",
        phone: "+12175559999",
        policy: "Please arrive 10 min early.",
      };
      const expectedServices = [
        { name: "Custom Cleaning", price: 110, description: "Deep clean." },
      ];
      const kv = {
        get: vi.fn(async (key: string) =>
          key === BUSINESS_INFO_KV_KEY
            ? JSON.stringify({ businessInfo: expectedInfo, services: expectedServices })
            : null
        ),
      };
      await store.initFromKv(kv);
      expect(store.getBusinessInfo()).toEqual(expectedInfo);
      expect(store.getServices()).toEqual(expectedServices);
      expect(store.isInitialized).toBe(true);
    });

    it("falls back to defaults when KV returns malformed JSON", async () => {
      const kv = { get: async () => "not json {{" };
      await store.initFromKv(kv);
      expect(store.getBusinessInfo().name).toBe("Bright Smile Dental");
    });

    it("falls back to defaults when business info object is missing required fields (location/phone/policy)", async () => {
      const kv = {
        get: async () =>
          JSON.stringify({
            businessInfo: { name: "Missing Fields", hours: "Y" },
            services: [],
          }),
      };
      await store.initFromKv(kv);
      expect(store.getBusinessInfo().name).toBe("Bright Smile Dental");
    });

    it("ignores services that don't match the Service shape", async () => {
      const kv = {
        get: async () =>
          JSON.stringify({
            businessInfo: {
              name: "X", hours: "Y", location: "Z", phone: "P", policy: "Q",
            },
            services: [{ name: "Bad Service", price: "not a number" }],
          }),
      };
      await store.initFromKv(kv);
      expect(store.getBusinessInfo().name).toBe("X");
      const services = store.getServices();
      expect(services.length).toBe(5);
      expect(services[0].name).toBe("Routine Cleaning");
    });

    it("calling initFromKv twice only overrides when new KV provides valid data", async () => {
      const kv1 = {
        get: async () =>
          JSON.stringify({
            businessInfo: { name: "First", hours: "1", location: "2", phone: "3", policy: "4" },
            services: [],
          }),
      };
      await store.initFromKv(kv1);
      expect(store.getBusinessInfo().name).toBe("First");

      const kv2 = { get: async () => null };
      await store.initFromKv(kv2);
      expect(store.getBusinessInfo().name).toBe("First");
    });

    it("store works without initFromKv being called (uses defaults, tests use this path)", () => {
      expect(store.getBusinessInfo().name).toBe("Bright Smile Dental");
      expect(store.isInitialized).toBe(false);
    });
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
    it("returns slots for a given date", async () => {
      const slots = await store.checkAvailability("2026-12-02");
      expect(slots.length).toBeGreaterThan(0);
      expect(slots[0].date).toBe("2026-12-02");
      expect(slots[0].time).toBeDefined();
      expect(slots[0].dentist).toBeDefined();
    });

    it("returns empty for a Sunday (clinic closed)", async () => {
      const slots = await store.checkAvailability("2026-12-06");
      expect(slots).toEqual([]);
    });

    it("excludes past times when checking today with a current time", async () => {
      const now = new Date("2026-11-16T14:30:00");
      const slots = await store.checkAvailability("2026-11-16", now);
      expect(slots.find((s) => s.time === "09:00")).toBeUndefined();
      expect(slots.find((s) => s.time === "13:00")).toBeUndefined();
      expect(slots.find((s) => s.time === "15:00")).toBeDefined();
      expect(slots.find((s) => s.time === "17:00")).toBeDefined();
    });

    it("includes all morning slots when checking today before opening", async () => {
      const now = new Date("2026-11-16T07:00:00");
      const slots = await store.checkAvailability("2026-11-16", now);
      expect(slots.find((s) => s.time === "09:00")).toBeDefined();
      expect(slots.find((s) => s.time === "11:00")).toBeDefined();
    });

    it("returns all slots for a future date regardless of now", async () => {
      const now = new Date("2026-11-16T20:00:00");
      const slots = await store.checkAvailability("2026-12-01", now);
      expect(slots.find((s) => s.time === "09:00")).toBeDefined();
    });

    it("returns all slots for today when now is not provided", async () => {
      const slots = await store.checkAvailability("2026-12-02");
      expect(slots.find((s) => s.time === "09:00")).toBeDefined();
    });

    it("excludes already booked slots", async () => {
      await store.createBooking({
        callerPhone: "+15551234567",
        name: "John",
        slot: { date: "2026-12-02", time: "09:00", dentist: "Dr. Lee" },
        reason: "cleaning",
      });
      const slots = await store.checkAvailability("2026-12-02");
      expect(slots.find((s) => s.time === "09:00")).toBeUndefined();
    });
  });

  describe("booking draft", () => {
    it("starts empty for a new caller", async () => {
      const draft = await store.getDraft("+15551234567");
      expect(draft).toBeNull();
    });

    it("saves a field and returns the updated draft", async () => {
      const draft = await store.updateDraft("+15551234567", "reason", "cleaning");
      expect(draft.reason).toBe("cleaning");
      expect(draft.preferredDate).toBeNull();
    });

    it("overwrites a field when caller corrects", async () => {
      await store.updateDraft("+15551234567", "reason", "cleaning");
      const draft = await store.updateDraft("+15551234567", "reason", "root canal");
      expect(draft.reason).toBe("root canal");
    });

    it("accumulates fields across calls", async () => {
      await store.updateDraft("+15551234567", "reason", "cleaning");
      await store.updateDraft("+15551234567", "preferredDate", "2026-11-16");
      await store.updateDraft("+15551234567", "slot", { date: "2026-11-16", time: "09:00", dentist: "Dr. Lee" });
      await store.updateDraft("+15551234567", "name", "John");
      const draft = await store.getDraft("+15551234567");
      expect(draft).not.toBeNull();
      expect(draft!.reason).toBe("cleaning");
      expect(draft!.preferredDate).toBe("2026-11-16");
      expect(draft!.slot!.time).toBe("09:00");
      expect(draft!.name).toBe("John");
    });

    it("isolates drafts per caller", async () => {
      await store.updateDraft("+15551234567", "reason", "cleaning");
      await store.updateDraft("+19998887777", "reason", "checkup");
      const d1 = await store.getDraft("+15551234567");
      const d2 = await store.getDraft("+19998887777");
      expect(d1).not.toBeNull();
      expect(d2).not.toBeNull();
      expect(d1!.reason).toBe("cleaning");
      expect(d2!.reason).toBe("checkup");
    });
  });

  describe("create booking from draft", () => {
    it("creates a booking and returns confirmation", async () => {
      await store.updateDraft("+15551234567", "reason", "cleaning");
      await store.updateDraft("+15551234567", "slot", { date: "2026-11-16", time: "09:00", dentist: "Dr. Lee" });
      await store.updateDraft("+15551234567", "name", "John");
      const booking = await store.createBooking({ callerPhone: "+15551234567" });
      expect(booking.bookingId).toBeDefined();
      expect(booking.date).toBe("2026-11-16");
      expect(booking.time).toBe("09:00");
      expect(booking.dentist).toBe("Dr. Lee");
      expect(booking.confirmed).toBe(true);
    });

    it("clears the draft after booking", async () => {
      await store.updateDraft("+15551234567", "reason", "cleaning");
      await store.updateDraft("+15551234567", "slot", { date: "2026-11-16", time: "09:00", dentist: "Dr. Lee" });
      await store.updateDraft("+15551234567", "name", "John");
      await store.createBooking({ callerPhone: "+15551234567" });
      expect(await store.getDraft("+15551234567")).toBeNull();
    });

    it("throws if draft is missing required fields", async () => {
      await store.updateDraft("+15551234567", "reason", "cleaning");
      await expect(store.createBooking({ callerPhone: "+15551234567" })).rejects.toThrow();
    });
  });

  describe("cancel booking", () => {
    it("cancels an existing booking by phone", async () => {
      await store.updateDraft("+15551234567", "reason", "cleaning");
      await store.updateDraft("+15551234567", "slot", { date: "2026-11-16", time: "09:00", dentist: "Dr. Lee" });
      await store.updateDraft("+15551234567", "name", "John");
      await store.createBooking({ callerPhone: "+15551234567" });
      const result = await store.cancelBooking("+15551234567");
      expect(result.cancelled).toBe(true);
      expect(result.date).toBe("2026-11-16");
    });

    it("returns not found for a caller with no booking", async () => {
      const result = await store.cancelBooking("+19998887777");
      expect(result.cancelled).toBe(false);
      expect(result.reason).toContain("no booking");
    });
  });

  describe("draft status", () => {
    it("returns next_step and missing_fields for a partial draft", async () => {
      await store.updateDraft("+15551234567", "reason", "cleaning");
      const status = await store.getDraftStatus("+15551234567");
      expect(status.nextStep).toBe("ask_preferred_date");
      expect(status.missingFields).toContain("preferredDate");
      expect(status.missingFields).toContain("slot");
      expect(status.missingFields).toContain("name");
    });

    it("returns next_step=search_slots when date is set", async () => {
      await store.updateDraft("+15551234567", "reason", "cleaning");
      await store.updateDraft("+15551234567", "preferredDate", "2026-11-16");
      const status = await store.getDraftStatus("+15551234567");
      expect(status.nextStep).toBe("search_slots");
      expect(status.missingFields).toContain("slot");
    });

    it("returns next_step=ask_name when slot is set", async () => {
      await store.updateDraft("+15551234567", "reason", "cleaning");
      await store.updateDraft("+15551234567", "preferredDate", "2026-11-16");
      await store.updateDraft("+15551234567", "slot", { date: "2026-11-16", time: "09:00", dentist: "Dr. Lee" });
      const status = await store.getDraftStatus("+15551234567");
      expect(status.nextStep).toBe("ask_name");
      expect(status.missingFields).toContain("name");
    });

    it("returns next_step=book when all fields are set", async () => {
      await store.updateDraft("+15551234567", "reason", "cleaning");
      await store.updateDraft("+15551234567", "preferredDate", "2026-11-16");
      await store.updateDraft("+15551234567", "slot", { date: "2026-11-16", time: "09:00", dentist: "Dr. Lee" });
      await store.updateDraft("+15551234567", "name", "John");
      const status = await store.getDraftStatus("+15551234567");
      expect(status.nextStep).toBe("book");
      expect(status.missingFields).toEqual([]);
    });

    it("returns next_step=ask_reason for a new caller", async () => {
      const status = await store.getDraftStatus("+15551234567");
      expect(status.nextStep).toBe("ask_reason");
      expect(status.missingFields).toContain("reason");
    });
  });
});
