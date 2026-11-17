import { StatefulActor } from "@telnyx/edge-runtime";
import type {
  Booking,
  BookingDraft,
  DraftStatus,
  Slot,
} from "./store/index.js";

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

export interface BookingActorState {
  draft: BookingDraft | null;
  booking: Booking | null;
  bookingCounter: number;
}

function freshState(): BookingActorState {
  return { draft: null, booking: null, bookingCounter: 0 };
}

/**
 * StatefulActor that owns the booking draft and confirmed booking for one
 * Telnyx conversation. Keyed by `telnyx_conversation_id` so that successive MCP
 * tool calls in the same voice call share state even when Telnyx Edge Compute
 * routes them to different function instances.
 *
 * Read-modify-write safety on `updateDraft` is provided by the actor's
 * single-threaded execution model: parallel tool calls for the same
 * conversation are serialized here, so one update never clobbers another.
 */
export class BookingActor extends StatefulActor {
  private async getState(): Promise<BookingActorState> {
    const s = await this.ctx.storage.get<BookingActorState>("state");
    if (s) return s;
    const fresh = freshState();
    await this.ctx.storage.put("state", fresh);
    return fresh;
  }

  private async setState(s: BookingActorState): Promise<void> {
    await this.ctx.storage.put("state", s);
  }

  async getDraft(): Promise<BookingDraft | null> {
    const s = await this.getState();
    return s.draft;
  }

  async updateDraft(
    field: keyof BookingDraft,
    value: string | Slot | null
  ): Promise<BookingDraft> {
    const s = await this.getState();
    const draft = s.draft ?? {
      reason: null,
      preferredDate: null,
      slot: null,
      name: null,
    };
    (draft as unknown as Record<string, unknown>)[field] = value;
    await this.setState({ ...s, draft });
    return draft;
  }

  async getDraftStatus(): Promise<DraftStatus> {
    const s = await this.getState();
    const draft = s.draft;
    if (!draft) {
      return { nextStep: "ask_reason", missingFields: [...FIELD_ORDER] };
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
    const s = await this.getState();
    const draft = s.draft;
    const name = args.name ?? draft?.name;
    const slot = args.slot ?? draft?.slot;
    const reason = args.reason ?? draft?.reason;

    if (!name || !slot || !reason) {
      throw new Error(
        "Missing required fields: name, slot, and reason are all required"
      );
    }

    const bookingId = `BK-${String(s.bookingCounter + 1).padStart(4, "0")}`;
    const booking: Booking = {
      bookingId,
      callerPhone: args.callerPhone,
      name,
      slot,
      reason,
      confirmed: true,
    };

    await this.setState({
      draft: null,
      booking,
      bookingCounter: s.bookingCounter + 1,
    });
    return {
      ...booking,
      date: slot.date,
      time: slot.time,
      dentist: slot.dentist,
    };
  }

  async cancelBooking(): Promise<{
    cancelled: boolean;
    date?: string;
    reason?: string;
  }> {
    const s = await this.getState();
    if (!s.booking) {
      return { cancelled: false, reason: "no booking found for this number" };
    }
    const date = s.booking.slot.date;
    await this.setState({ ...s, booking: null });
    return { cancelled: true, date };
  }

  /** Returns the current booking's slot if it falls on the given date. */
  async getBookedSlotForDate(date: string): Promise<Slot | null> {
    const s = await this.getState();
    if (!s.booking) return null;
    return s.booking.slot.date === date ? s.booking.slot : null;
  }
}

/** Stub interface for tests and non-actor environments. */
export interface BookingActorStub {
  getDraft(): Promise<BookingDraft | null>;
  updateDraft(
    field: keyof BookingDraft,
    value: string | Slot | null
  ): Promise<BookingDraft>;
  getDraftStatus(): Promise<DraftStatus>;
  createBooking(args: {
    callerPhone: string;
    name?: string;
    slot?: Slot;
    reason?: string;
  }): Promise<Booking & { date: string; time: string; dentist: string }>;
  cancelBooking(): Promise<{
    cancelled: boolean;
    date?: string;
    reason?: string;
  }>;
  getBookedSlotForDate(date: string): Promise<Slot | null>;
}

export function createBookingActorStub(actor: any): BookingActorStub {
  return {
    getDraft: () => actor.getDraft(),
    updateDraft: (field, value) => actor.updateDraft(field, value),
    getDraftStatus: () => actor.getDraftStatus(),
    createBooking: (args) => actor.createBooking(args),
    cancelBooking: () => actor.cancelBooking(),
    getBookedSlotForDate: (date) => actor.getBookedSlotForDate(date),
  };
}
