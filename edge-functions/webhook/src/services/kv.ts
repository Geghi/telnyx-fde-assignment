import type { Env } from "../types.js";

/** Same canonical KV key the MCP server reads. Single source of truth for clinic config. */
export const BUSINESS_INFO_KV_KEY = "business_info";

export const DEFAULT_BUSINESS_HOURS = "Mon-Fri 8am-6pm, Sat 9am-2pm, Sun closed";

export interface BusinessInfo {
  name: string;
  hours: string;
  location: string;
  phone: string;
  policy: string;
}

export async function getFeatureFlag(env: Env, key: string): Promise<string> {
  const value = await env.CLINIC_KV.get(key);
  return value ?? "true";
}

export async function getClinicHours(env: Env): Promise<string> {
  const raw = await env.CLINIC_KV.get(BUSINESS_INFO_KV_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<BusinessInfo>;
      if (parsed?.hours) return parsed.hours;
    } catch {
      // fall through to default
    }
  }
  return DEFAULT_BUSINESS_HOURS;
}

export async function incrementCounter(env: Env, key: string): Promise<void> {
  const current = await env.CLINIC_KV.get(key);
  const next = (parseInt(current ?? "0", 10) + 1).toString();
  await env.CLINIC_KV.put(key, next);
}

export async function getCounter(env: Env, key: string): Promise<number> {
  const value = await env.CLINIC_KV.get(key);
  const parsed = parseInt(value ?? "0", 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}
