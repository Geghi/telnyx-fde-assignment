import type { Env } from "../types.js";

export async function getFeatureFlag(env: Env, key: string): Promise<string> {
  const value = await env.CLINIC_KV.get(key);
  return value ?? "true";
}

export async function getClinicHours(env: Env): Promise<string> {
  const cached = await env.CLINIC_KV.get("clinic_hours");
  if (cached) return cached;
  return "Mon-Fri 8am-6pm, Sat 9am-2pm, Sun closed";
}

export async function incrementCounter(env: Env, key: string): Promise<void> {
  const current = await env.CLINIC_KV.get(key);
  const next = (parseInt(current ?? "0", 10) + 1).toString();
  await env.CLINIC_KV.put(key, next);
}

export async function getCounter(env: Env, key: string): Promise<number> {
  const value = await env.CLINIC_KV.get(key);
  return parseInt(value ?? "0", 10);
}
