import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Store } from "../store/index.js";
import type { Slot } from "../store/index.js";

export function createMcpServer(store: Store): McpServer {
  const server = new McpServer(
    { name: "bright-smile-dental", version: "1.0.0" },
    {
      instructions:
        "MCP server for Bright Smile Dental. Read-only clinic data: business info, services and appointment availability. Booking writes are separate webhook tools scoped to the Booking and Cancellation nodes.",
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
    "Checks open appointment slots for a given date. Returns available time slots with dentist names. Date must be YYYY-MM-DD format. Slots in the past (earlier today than now) are excluded automatically.",
    {
      date_from: z.string().describe("Date to search from (YYYY-MM-DD)"),
      date_to: z
        .string()
        .optional()
        .describe("Optional end date for range search (YYYY-MM-DD). Defaults to date_from only."),
    },
    async (args) => {
      const now = new Date();
      const slots: Slot[] = [];
      const pad = (n: number) => String(n).padStart(2, "0");
      const ymd = (d: Date) =>
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      if (args.date_to) {
        const start = new Date(args.date_from + "T00:00:00");
        const end = new Date(args.date_to + "T00:00:00");
        for (let d = start; d <= end; d.setDate(d.getDate() + 1)) {
          slots.push(...(await store.checkAvailability(ymd(d), now)));
        }
      } else {
        slots.push(...(await store.checkAvailability(args.date_from, now)));
      }
      return {
        content: [
          {
            type: "text" as const,
            text:
              slots.length === 0
                ? "No available slots found. The clinic may be closed on that date, or all remaining slots today are in the past."
                : JSON.stringify(slots, null, 2),
          },
        ],
      };
    }
  );

  return server;
}
