import { z } from "zod";
import type { Store } from "./store/index.js";
import type { CallbackQueueStub } from "./actor.js";

/**
 * HTTP entry points for the booking write tools. Telnyx calls them as shared
 * webhook tools, scoped to the Booking / Cancellation workflow nodes, and adds
 * `caller_phone` via a preset body field the LLM never sees.
 */

const slotSchema = z.object({ date: z.string(), time: z.string(), dentist: z.string() });

const schemas = {
  update_booking_draft: z
    .object({
      field: z.enum(["reason", "preferredDate", "slot", "name"]),
      // Telnyx sends omitted optional params as null.
      value: z.string().nullish(),
      slot: slotSchema.nullish(),
    })
    .refine((a) => (a.field === "slot" ? a.slot != null : a.value != null), {
      message: "Pass `slot` {date, time, dentist} when field is 'slot', otherwise pass `value`",
    }),
  get_booking_status: z.object({}),
  book_appointment: z.object({}),
  save_booking_request: z.object({}),
  get_appointment: z.object({}),
  cancel_appointment: z.object({}),
};

export interface ToolDeps {
  store: Store;
  caller: string;
  /** Staff call-back list; null when the actor binding is missing. */
  queue: CallbackQueueStub | null;
  /** Live KV read, so toggling the flag applies without waiting for a new call. */
  onlineBookingEnabled(): Promise<boolean>;
}

const isMissingFields = (err: unknown) => (err as Error).message.startsWith("Missing required fields");

export type ToolName = keyof typeof schemas;

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(schemas, name);
}

/**
 * Chat mode has no caller id, so the preset arrives empty or as the raw
 * `{{caller_phone}}` template; those requests share one "unknown" caller.
 */
export function callerKey(raw: unknown): string {
  const phone = typeof raw === "string" ? raw.trim() : "";
  if (!phone || phone.includes("{{")) {
    console.warn("[tools] no caller_phone on request; using 'unknown' caller");
    return "unknown";
  }
  return phone;
}

export async function runTool(
  name: ToolName,
  body: Record<string, unknown>,
  { store, caller, queue, onlineBookingEnabled }: ToolDeps
): Promise<Response> {
  const parsed = schemas[name].safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }

  switch (name) {
    case "update_booking_draft": {
      const { field, value, slot } = parsed.data as z.infer<typeof schemas.update_booking_draft>;
      const draft = await store.updateDraft(caller, field, field === "slot" ? slot! : value!);
      return Response.json({ draft, status: await store.getDraftStatus(caller) });
    }
    case "get_booking_status":
      return Response.json({
        draft: await store.getDraft(caller),
        status: await store.getDraftStatus(caller),
      });
    case "book_appointment":
      if (!(await onlineBookingEnabled())) {
        return Response.json({
          error: "Online booking is disabled. Do not book; save the request with save_booking_request instead.",
        });
      }
      try {
        return Response.json(await store.createBooking({ callerPhone: caller }));
      } catch (err) {
        if (!isMissingFields(err)) throw err;
        // 200 so the LLM reads the reason and asks for the missing field.
        return Response.json({ error: (err as Error).message });
      }
    case "save_booking_request":
      try {
        const request = await store.saveRequest(caller);
        await queue?.addCallback(request);
        return Response.json(request);
      } catch (err) {
        if (!isMissingFields(err)) throw err;
        return Response.json({ error: (err as Error).message });
      }
    case "get_appointment":
      return Response.json(await store.getAppointment());
    case "cancel_appointment": {
      const result = await store.cancelBooking(caller);
      if (result.cancelled && result.kind === "request") await queue?.removeCallback(caller);
      return Response.json(result);
    }
  }
}
