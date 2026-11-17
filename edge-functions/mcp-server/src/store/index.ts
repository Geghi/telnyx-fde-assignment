import type { BookingActorStub } from "../actor.js";

export interface Slot {
  date: string;
  time: string;
  dentist: string;
}

export interface Service {
  name: string;
  price: number;
  description: string;
}

export interface BusinessInfo {
  name: string;
  hours: string;
  location: string;
  phone: string;
  policy: string;
}

export interface BookingDraft {
  reason: string | null;
  preferredDate: string | null;
  slot: Slot | null;
  name: string | null;
}

export interface Booking {
  bookingId: string;
  callerPhone: string;
  name: string;
  slot: Slot;
  reason: string;
  confirmed: boolean;
}

export interface DraftStatus {
  nextStep: string;
  missingFields: string[];
}

/** KV key holding the canonical clinic config (business info + services). */
export const BUSINESS_INFO_KV_KEY = "business_info";

/** Default hours string, returned by the webhook when KV is missing/empty. */
export const DEFAULT_BUSINESS_HOURS = "Mon-Fri 8am-6pm, Sat 9am-2pm, Sun closed";

interface KvStore {
  get(key: string): Promise<string | null>;
}

interface BusinessConfig {
  businessInfo: BusinessInfo;
  services: Service[];
}

const FIELD_ORDER: (keyof BookingDraft)[] = [
  "reason",
  "preferredDate",
  "slot",
  "name",
];

const NEXT_STEP_MAP: Record<string, string> = {
  reason: "ask_preferred_date",
  preferredDate: "search_slots",
  slot: "ask_name",
  name: "book",
};

export class Store {
  private appointments: Map<string, Booking> = new Map();
  private drafts: Map<string, BookingDraft> = new Map();
  private bookingCounter = 0;
  private initialized = false;

  /**
   * Optional per-request actor backend. When set, draft and booking
   * operations proxy to the BookingActor stub keyed by the Telnyx
   * conversation id. When unset (tests, no env binding), the in-memory
   * Maps below are used.
   */
  private actor: BookingActorStub | null = null;
  private conversationKey: string | null = null;

  /**
   * Route draft and booking operations through a per-conversation
   * `BookingActor` stub. Called once per request in production, after
   * the MCP request's `_meta.telnyx_conversation_id` is extracted.
   */
  setActorBackend(stub: BookingActorStub, conversationId: string): void {
    this.actor = stub;
    this.conversationKey = conversationId;
  }

  private hasActor(): boolean {
    return this.actor !== null && this.conversationKey !== null;
  }

  private businessInfo: BusinessInfo = {
    name: "Bright Smile Dental",
    hours: "Mon-Fri 8am-6pm, Sat 9am-2pm, Sun closed",
    location: "123 Smile Ave, Springfield, IL 62701",
    phone: "+12175551234",
    policy:
      "Please arrive 15 minutes early. Cancel at least 24 hours in advance to avoid a fee.",
  };

  private services: Service[] = [
    {
      name: "Routine Cleaning",
      price: 95,
      description: "Professional cleaning and polishing, including X-rays if due.",
    },
    {
      name: "Dental Exam",
      price: 75,
      description: "Comprehensive oral health examination by one of our dentists.",
    },
    {
      name: "Root Canal",
      price: 800,
      description: "Endodontic treatment to save a damaged or infected tooth.",
    },
    {
      name: "Tooth Extraction",
      price: 250,
      description: "Simple or surgical extraction depending on complexity.",
    },
    {
      name: "Teeth Whitening",
      price: 350,
      description: "In-office professional whitening for a brighter smile.",
    },
  ];

  private readonly timeSlots = [
    "09:00",
    "10:00",
    "11:00",
    "13:00",
    "14:00",
    "15:00",
    "16:00",
    "17:00",
  ];

  get isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Load clinic config (business info + services) from the shared
   * CLINIC_KV namespace. Falls back to the hardcoded defaults above when KV
   * is missing, unreadable, or malformed. Idempotent. Safe to call from a
   * non-KV environment (tests) — pass a no-op kv.
   */
  async initFromKv(kv: KvStore): Promise<void> {
    try {
      const raw = await kv.get(BUSINESS_INFO_KV_KEY);
      if (!raw) {
        this.initialized = true;
        return;
      }
      const parsed = JSON.parse(raw) as Partial<BusinessConfig>;
      if (parsed.businessInfo && isValidBusinessInfo(parsed.businessInfo)) {
        this.businessInfo = parsed.businessInfo;
      }
      if (Array.isArray(parsed.services) && parsed.services.every(isValidService)) {
        this.services = parsed.services;
      }
    } catch {
      // KV read or parse failure — keep defaults.
    }
    this.initialized = true;
  }

  getBusinessInfo(): BusinessInfo {
    return this.businessInfo;
  }

  getServices(): Service[] {
    return this.services;
  }

  /**
   * Replace the static clinic config (business info + services) with
   * values loaded and cached elsewhere. Used to seed per-request Store
   * instances without re-reading KV on every call. Safe to call any
   * time; `initFromKv` overrides if it runs later against a real KV.
   */
  setStaticData(businessInfo: BusinessInfo, services: Service[]): void {
    this.businessInfo = businessInfo;
    this.services = services;
    this.initialized = true;
  }

  async checkAvailability(date: string, now: Date = new Date()): Promise<Slot[]> {
    const day = new Date(date + "T00:00:00");
    const dow = day.getDay();
    if (dow === 0) return [];

    const dentists = ["Dr. Lee", "Dr. Patel"];
    let bookedTimes = new Set<string>();
    if (this.hasActor()) {
      const bookedSlot = await this.actor!.getBookedSlotForDate(date);
      if (bookedSlot) bookedTimes.add(bookedSlot.time);
    } else {
      bookedTimes = new Set(
        [...this.appointments.values()]
          .filter((b) => b.slot.date === date)
          .map((b) => b.slot.time)
      );
    }

    const today = now.toISOString().slice(0, 10);
    const currentHourMin =
      now.getUTCHours() * 60 + now.getUTCMinutes();
    const isToday = date === today;

    const slots: Slot[] = [];
    for (const time of this.timeSlots) {
      if (bookedTimes.has(time)) continue;
      if (dow === 6 && parseInt(time) >= 15) continue;
      if (isToday) {
        const [h, m] = time.split(":").map(Number);
        const slotMinutes = h * 60 + m;
        if (slotMinutes <= currentHourMin) continue;
      }
      const dentist = dentists[slots.length % dentists.length];
      slots.push({ date, time, dentist });
    }
    return slots;
  }

  async getDraft(callerPhone: string): Promise<BookingDraft | null> {
    if (this.hasActor()) return this.actor!.getDraft();
    return this.drafts.get(callerPhone) ?? null;
  }

  async updateDraft(
    callerPhone: string,
    field: keyof BookingDraft,
    value: string | Slot | null
  ): Promise<BookingDraft> {
    if (this.hasActor()) {
      return this.actor!.updateDraft(field, value);
    }
    const draft = this.drafts.get(callerPhone) ?? {
      reason: null,
      preferredDate: null,
      slot: null,
      name: null,
    };
    (draft as unknown as Record<string, unknown>)[field] = value;
    this.drafts.set(callerPhone, draft);
    return draft;
  }

  async getDraftStatus(callerPhone: string): Promise<DraftStatus> {
    if (this.hasActor()) return this.actor!.getDraftStatus();
    const draft = this.drafts.get(callerPhone);
    if (!draft) {
      return {
        nextStep: "ask_reason",
        missingFields: [...FIELD_ORDER],
      };
    }

    const missing = FIELD_ORDER.filter((f) => draft[f] === null);
    const lastFilled = FIELD_ORDER.filter((f) => draft[f] !== null).pop();
    const nextStep =
      lastFilled && NEXT_STEP_MAP[lastFilled]
        ? NEXT_STEP_MAP[lastFilled]
        : "ask_reason";

    return { nextStep, missingFields: missing };
  }

  async createBooking(args: {
    callerPhone: string;
    name?: string;
    slot?: Slot;
    reason?: string;
  }): Promise<Booking & { date: string; time: string; dentist: string }> {
    if (this.hasActor()) {
      return this.actor!.createBooking({
        callerPhone: args.callerPhone,
        name: args.name,
        slot: args.slot,
        reason: args.reason,
      });
    }

    const draft = this.drafts.get(args.callerPhone);
    const name = args.name ?? draft?.name;
    const slot = args.slot ?? draft?.slot;
    const reason = args.reason ?? draft?.reason;

    if (!name || !slot || !reason) {
      throw new Error("Missing required fields: name, slot, and reason are all required");
    }

    this.bookingCounter += 1;
    const booking: Booking = {
      bookingId: `BK-${String(this.bookingCounter).padStart(4, "0")}`,
      callerPhone: args.callerPhone,
      name,
      slot,
      reason,
      confirmed: true,
    };

    this.appointments.set(args.callerPhone, booking);
    this.drafts.delete(args.callerPhone);
    return { ...booking, date: slot.date, time: slot.time, dentist: slot.dentist };
  }

  async cancelBooking(
    callerPhone: string
  ): Promise<{ cancelled: boolean; date?: string; reason?: string }> {
    if (this.hasActor()) return this.actor!.cancelBooking();
    const booking = this.appointments.get(callerPhone);
    if (!booking) {
      return { cancelled: false, reason: "no booking found for this number" };
    }
    this.appointments.delete(callerPhone);
    return { cancelled: true, date: booking.slot.date };
  }
}

function isValidBusinessInfo(v: unknown): v is BusinessInfo {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.name === "string" &&
    typeof o.hours === "string" &&
    typeof o.location === "string" &&
    typeof o.phone === "string" &&
    typeof o.policy === "string"
  );
}

function isValidService(v: unknown): v is Service {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.name === "string" &&
    typeof o.price === "number" &&
    typeof o.description === "string"
  );
}
