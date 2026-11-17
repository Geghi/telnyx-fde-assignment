import { StatefulActor } from "@telnyx/edge-runtime";
import type {
  Booking,
  BookingDraft,
  CallbackRequest,
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
  request: CallbackRequest | null;
  requestCounter: number;
  /** Only used on the clinic-wide `clinic:callbacks` instance: the staff call-back list. */
  callbacks: CallbackRequest[];
}

export interface CancelResult {
  cancelled: boolean;
  kind?: "booking" | "request";
  date?: string;
  reason?: string;
}

function freshState(): BookingActorState {
  return { draft: null, booking: null, bookingCounter: 0, request: null, requestCounter: 0, callbacks: [] };
}

/**
 * StatefulActor that owns the booking draft and confirmed booking for one
 * caller. Keyed `caller:<caller_phone>` so tool calls share state across
 * function instances and across calls: a booking made on one call can be
 * cancelled on the next.
 *
 * Read-modify-write safety on `updateDraft` is provided by the actor's
 * single-threaded execution model: parallel tool calls for the same
 * caller are serialized here, so one update never clobbers another.
 */
export class BookingActor extends StatefulActor {
  private async getState(): Promise<BookingActorState> {
    const s = await this.ctx.storage.get<BookingActorState>("state");
    // Spread over defaults so state saved before a field existed still loads.
    if (s) return { ...freshState(), ...s };
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
      ...s,
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

  /** Saves the draft as a call-back request (online booking disabled). The slot is optional. */
  async saveRequest(callerPhone: string): Promise<CallbackRequest> {
    const s = await this.getState();
    const d = s.draft;
    const missing = (["reason", "preferredDate", "name"] as const).filter((f) => !d?.[f]);
    if (missing.length) {
      throw new Error(`Missing required fields: ${missing.join(", ")}`);
    }
    const request: CallbackRequest = {
      requestId: `RQ-${String(s.requestCounter + 1).padStart(4, "0")}`,
      callerPhone,
      name: d!.name!,
      reason: d!.reason!,
      preferredDate: d!.preferredDate!,
      slot: d!.slot ?? null,
      status: "callback_requested",
      createdAt: new Date().toISOString(),
    };
    await this.setState({ ...s, draft: null, request, requestCounter: s.requestCounter + 1 });
    return request;
  }

  async getAppointment(): Promise<{ booking: Booking | null; request: CallbackRequest | null }> {
    const s = await this.getState();
    return { booking: s.booking, request: s.request };
  }

  /** Cancels the confirmed booking if there is one, otherwise the pending request. */
  async cancelBooking(): Promise<CancelResult> {
    const s = await this.getState();
    if (s.booking) {
      await this.setState({ ...s, booking: null });
      return { cancelled: true, kind: "booking", date: s.booking.slot.date };
    }
    if (s.request) {
      await this.setState({ ...s, request: null });
      return { cancelled: true, kind: "request", date: s.request.preferredDate };
    }
    return { cancelled: false, reason: "no booking found for this number" };
  }

  /** Clinic-wide queue: one entry per caller, a newer request replaces the older one. */
  async addCallback(request: CallbackRequest): Promise<void> {
    const s = await this.getState();
    const callbacks = s.callbacks.filter((r) => r.callerPhone !== request.callerPhone);
    await this.setState({ ...s, callbacks: [...callbacks, request] });
  }

  async removeCallback(callerPhone: string): Promise<void> {
    const s = await this.getState();
    await this.setState({ ...s, callbacks: s.callbacks.filter((r) => r.callerPhone !== callerPhone) });
  }

  async listCallbacks(): Promise<CallbackRequest[]> {
    return (await this.getState()).callbacks;
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
  cancelBooking(): Promise<CancelResult>;
  getBookedSlotForDate(date: string): Promise<Slot | null>;
  saveRequest(callerPhone: string): Promise<CallbackRequest>;
  getAppointment(): Promise<{ booking: Booking | null; request: CallbackRequest | null }>;
}

/** The clinic-wide `clinic:callbacks` BookingActor instance, seen as a queue. */
export interface CallbackQueueStub {
  addCallback(request: CallbackRequest): Promise<void>;
  removeCallback(callerPhone: string): Promise<void>;
  listCallbacks(): Promise<CallbackRequest[]>;
}

export function createCallbackQueueStub(actor: any): CallbackQueueStub {
  return {
    addCallback: (r) => actor.addCallback(r),
    removeCallback: (p) => actor.removeCallback(p),
    listCallbacks: () => actor.listCallbacks(),
  };
}

export function createBookingActorStub(actor: any): BookingActorStub {
  return {
    getDraft: () => actor.getDraft(),
    updateDraft: (field, value) => actor.updateDraft(field, value),
    getDraftStatus: () => actor.getDraftStatus(),
    createBooking: (args) => actor.createBooking(args),
    cancelBooking: () => actor.cancelBooking(),
    getBookedSlotForDate: (date) => actor.getBookedSlotForDate(date),
    saveRequest: (callerPhone) => actor.saveRequest(callerPhone),
    getAppointment: () => actor.getAppointment(),
  };
}
