import { StatefulActor } from "@telnyx/edge-runtime";
import type { CallSessionState, CallSessionStub } from "../types.js";

export class CallSession extends StatefulActor {
  async getOrCreate(): Promise<CallSessionState> {
    const state = await this.ctx.storage.get<CallSessionState>("session");
    if (state) return state;
    const fresh: CallSessionState = {
      callerName: null,
      lastBookingId: null,
      totalCalls: 0,
    };
    await this.ctx.storage.put("session", fresh);
    return fresh;
  }

  async recordCall(): Promise<{ totalCalls: number }> {
    const state = await this.getOrCreate();
    const next = state.totalCalls + 1;
    await this.ctx.storage.put("session", { ...state, totalCalls: next });
    return { totalCalls: next };
  }

  async updateCallerName(name: string): Promise<void> {
    const state = await this.getOrCreate();
    await this.ctx.storage.put("session", { ...state, callerName: name });
  }

  async setLastBooking(bookingId: string): Promise<void> {
    const state = await this.getOrCreate();
    await this.ctx.storage.put("session", { ...state, lastBookingId: bookingId });
  }
}

export function createCallSessionStub(actor: any): CallSessionStub {
  return {
    getOrCreate: () => actor.getOrCreate(),
    updateCallerName: (name: string) => actor.updateCallerName(name),
    recordCall: () => actor.recordCall(),
    setLastBooking: (bookingId: string) => actor.setLastBooking(bookingId),
  };
}
