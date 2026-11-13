import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Store } from "../store/index.js";
import type { Slot } from "../store/index.js";

export function createMcpServer(store: Store): McpServer {
  const server = new McpServer(
    { name: "bright-smile-dental", version: "1.0.0" },
    {
      instructions:
        "MCP server for Bright Smile Dental. Provides scheduling tools: check availability, book/cancel appointments, get services and business info, and manage booking drafts with progressive status.",
    }
  );

  server.tool(
    "get_business_info",
    "Returns clinic hours, location, phone number, and policies. Use when the caller asks about hours, location, or clinic policies.",
    {},
    async () => {
      const info = store.getBusinessInfo();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(info, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "get_services",
    "Returns the list of dental services with prices and descriptions. Use when the caller asks about services, treatments, or pricing.",
    {},
    async () => {
      const services = store.getServices();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(services, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "check_availability",
    "Checks open appointment slots for a given date. Returns available time slots with dentist names. Date must be YYYY-MM-DD format.",
    {
      date_from: z.string().describe("Date to search from (YYYY-MM-DD)"),
      date_to: z
        .string()
        .optional()
        .describe("Optional end date for range search (YYYY-MM-DD). Defaults to date_from only."),
    },
    async (args) => {
      const slots: Slot[] = [];
      if (args.date_to) {
        const start = new Date(args.date_from + "T00:00:00");
        const end = new Date(args.date_to + "T00:00:00");
        for (let d = start; d <= end; d.setDate(d.getDate() + 1)) {
          slots.push(
            ...store.checkAvailability(d.toISOString().split("T")[0]!)
          );
        }
      } else {
        slots.push(...store.checkAvailability(args.date_from));
      }
      return {
        content: [
          {
            type: "text" as const,
            text:
              slots.length === 0
                ? "No available slots found. The clinic may be closed on that date."
                : JSON.stringify(slots, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "update_booking_draft",
    "Saves a piece of booking information as the caller provides it. Returns the current draft and a status object with next_step and missing_fields. Caller can update any field at any time to correct it. The caller_phone is passed automatically as a dynamic variable.",
    {
      caller_phone: z
        .string()
        .describe("The caller's phone number (E.164 format, e.g. +15551234567)"),
      field: z
        .enum(["reason", "preferredDate", "slot", "name"])
        .describe("The draft field to update"),
      value: z
        .union([z.string(), z.object({
          date: z.string(),
          time: z.string(),
          dentist: z.string(),
        })])
        .describe("The value for the field. For 'slot', pass an object with date, time, and dentist."),
    },
    async (args) => {
      const draft = store.updateDraft(
        args.caller_phone,
        args.field as "reason" | "preferredDate" | "slot" | "name",
        args.value as string | Slot | null
      );
      const status = store.getDraftStatus(args.caller_phone);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ draft, status }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "get_booking_status",
    "Returns the current booking draft and its status (next_step and missing_fields) for a caller. Use this first to check if a returning caller has an in-progress draft.",
    {
      caller_phone: z
        .string()
        .describe("The caller's phone number (E.164 format)"),
    },
    async (args) => {
      const draft = store.getDraft(args.caller_phone);
      const status = store.getDraftStatus(args.caller_phone);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ draft, status }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "book_appointment",
    "Creates a confirmed booking from the caller's draft. All draft fields must be filled (reason, preferredDate, slot, name). The caller_phone identifies which draft to use. Returns a booking confirmation with booking ID, date, time, and dentist.",
    {
      caller_phone: z
        .string()
        .describe("The caller's phone number (E.164 format)"),
    },
    async (args) => {
      try {
        const booking = store.createBooking({ callerPhone: args.caller_phone });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(booking, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${(err as Error).message}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "cancel_appointment",
    "Cancels an existing appointment by the caller's phone number. Returns cancellation confirmation or 'no booking found' if none exists.",
    {
      caller_phone: z
        .string()
        .describe("The caller's phone number (E.164 format)"),
      booking_id: z
        .string()
        .optional()
        .describe("Optional booking ID to cancel a specific booking"),
    },
    async (args) => {
      const result = store.cancelBooking(args.caller_phone);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  return server;
}
