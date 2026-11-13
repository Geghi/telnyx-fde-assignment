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

  private readonly businessInfo: BusinessInfo = {
    name: "Bright Smile Dental",
    hours: "Mon-Fri 8am-6pm, Sat 9am-2pm, Sun closed",
    location: "123 Smile Ave, Springfield, IL 62701",
    phone: "+12175551234",
    policy:
      "Please arrive 15 minutes early. Cancel at least 24 hours in advance to avoid a fee.",
  };

  private readonly services: Service[] = [
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

  getBusinessInfo(): BusinessInfo {
    return this.businessInfo;
  }

  getServices(): Service[] {
    return this.services;
  }

  checkAvailability(date: string): Slot[] {
    const day = new Date(date + "T00:00:00");
    const dow = day.getDay();
    if (dow === 0) return [];

    const dentists = ["Dr. Lee", "Dr. Patel"];
    const booked = new Set(
      [...this.appointments.values()]
        .filter((b) => b.slot.date === date)
        .map((b) => b.slot.time)
    );

    const slots: Slot[] = [];
    for (const time of this.timeSlots) {
      if (booked.has(time)) continue;
      if (dow === 6 && parseInt(time) >= 15) continue;
      const dentist = dentists[slots.length % dentists.length];
      slots.push({ date, time, dentist });
    }
    return slots;
  }

  getDraft(callerPhone: string): BookingDraft | null {
    return this.drafts.get(callerPhone) ?? null;
  }

  updateDraft(
    callerPhone: string,
    field: keyof BookingDraft,
    value: string | Slot | null
  ): BookingDraft {
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

  getDraftStatus(callerPhone: string): DraftStatus {
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

  createBooking(args: {
    callerPhone: string;
    name?: string;
    slot?: Slot;
    reason?: string;
  }): Booking & { date: string; time: string; dentist: string } {
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

  cancelBooking(
    callerPhone: string
  ): { cancelled: boolean; date?: string; reason?: string } {
    const booking = this.appointments.get(callerPhone);
    if (!booking) {
      return { cancelled: false, reason: "no booking found for this number" };
    }
    this.appointments.delete(callerPhone);
    return { cancelled: true, date: booking.slot.date };
  }
}
