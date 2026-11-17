import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const envPath = resolve(repoRoot, ".env.local");

function loadEnvFile() {
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = value;
  }
}
loadEnvFile();

const API_BASE = "https://api.telnyx.com/v2";
const API_KEY = process.env.TELNYX_API_KEY;

const COUNTRY_CODE = process.env.BUY_COUNTRY_CODE ?? "US";
const NUMBER_TYPE = process.env.BUY_NUMBER_TYPE ?? "local";
const AREA_CODE = process.env.BUY_AREA_CODE ?? "";
const FEATURES = process.env.BUY_FEATURES ?? "voice";
const SEARCH_LIMIT = 5;

function assertEnv(name: string, value: string | undefined): asserts value is string {
  if (!value) {
    console.error(`Missing ${name}. Set it in .env.local (see .env.example).`);
    process.exit(1);
  }
}

async function api(
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string | string[]> } = {}
): Promise<any> {
  const url = new URL(`${API_BASE}${path}`);
  if (init.query) {
    for (const [k, v] of Object.entries(init.query)) {
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
      else url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function listOwnedNumbers(): Promise<string[]> {
  const body = await api("/phone_numbers");
  const data = body.data ?? [];
  return data.map((n: { phone_number: string }) => n.phone_number);
}

async function searchAvailable(): Promise<string[]> {
  const query: Record<string, string | string[]> = {
    "filter[country_code]": COUNTRY_CODE,
    "filter[phone_number_type]": NUMBER_TYPE,
    "filter[limit]": String(SEARCH_LIMIT),
    "filter[best_effort]": "false",
  };
  if (AREA_CODE) query["filter[national_destination_code]"] = AREA_CODE;
  if (FEATURES) query["filter[features][]"] = FEATURES.split(",").map((f) => f.trim());
  const body = await api("/available_phone_numbers", { query });
  const data = body.data ?? [];
  return data
    .filter((n: { reservable?: boolean; best_effort?: boolean }) =>
      n.reservable !== false && n.best_effort !== true
    )
    .map((n: { phone_number: string }) => n.phone_number);
}

async function buyNumber(phoneNumber: string): Promise<"bought" | "account-blocked" | "failed"> {
  await sleep(1200);
  try {
    const body = await api("/number_orders", {
      method: "POST",
      body: { phone_numbers: [{ phone_number: phoneNumber }] },
    });
    const status = body?.data?.status ?? body?.status;
    if (status && !["pending", "success", "complete"].includes(status)) {
      console.log(`  Order for ${phoneNumber} returned status: ${status}`);
      return "failed";
    }
    return "bought";
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("10038") || msg.includes("not permitted at this account level")) {
      console.log(`  Account level does not permit API number purchases (10038).`);
      return "account-blocked";
    }
    if (msg.includes("10027") && msg.includes("Did you first search")) {
      console.log(`  ${phoneNumber} not orderable via API on this account (10027).`);
      return "account-blocked";
    }
    console.log(`  Could not order ${phoneNumber}: ${msg.split("\n")[0].slice(0, 160)}`);
    return "failed";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function writeEnv(number: string): void {
  const lines: string[] = [];
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf8");
    let found = false;
    for (const line of content.split("\n")) {
      const m = line.match(/^ASSISTANT_PHONE_NUMBER=(.*)$/);
      if (m) {
        lines.push(`ASSISTANT_PHONE_NUMBER=${number}`);
        found = true;
      } else {
        lines.push(line);
      }
    }
    if (!found) {
      if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
      lines.push(`ASSISTANT_PHONE_NUMBER=${number}`);
    }
  } else {
    lines.push(`ASSISTANT_PHONE_NUMBER=${number}`);
  }
  writeFileSync(envPath, lines.join("\n"));
}

async function main() {
  assertEnv("TELNYX_API_KEY", API_KEY);
  console.log("=== Buy a phone number for the assistant ===\n");

  const owned = await listOwnedNumbers();
  if (owned.length > 0) {
    console.log("You already own these numbers on your account:");
    for (const n of owned) console.log(`  ${n}`);
    writeEnv(owned[0]!);
    console.log(`\nWrote ASSISTANT_PHONE_NUMBER=${owned[0]} to .env.local.`);
    console.log("Re-run setup.ts to bind it to the assistant.");
    return;
  }

  console.log(`Searching for ${NUMBER_TYPE} numbers in ${COUNTRY_CODE}${AREA_CODE ? ` (area ${AREA_CODE})` : ""}...`);
  const candidates = await searchAvailable();
  if (candidates.length === 0) {
    console.error("No available numbers found. Try different filters (BUY_AREA_CODE, BUY_NUMBER_TYPE).");
    process.exit(1);
  }
  console.log("Candidate numbers:");
  candidates.forEach((n, i) => console.log(`  ${i + 1}. ${n}`));

  let bought: string | null = null;
  let accountBlocked = false;
  for (const candidate of candidates) {
    if (accountBlocked) break;
    console.log(`\nTrying ${candidate}...`);
    const result = await buyNumber(candidate);
    if (result === "bought") {
      bought = candidate;
      break;
    }
    if (result === "account-blocked") {
      accountBlocked = true;
    }
  }

  if (accountBlocked && !bought) {
    console.log(
      "\nAPI purchasing is not enabled on this Telnyx account level (promo code adds credit, but not API purchase rights).\n" +
      "Buy a number in the portal instead:\n" +
      "  1. https://portal.telnyx.com/#/app/numbers-buy\n" +
      "  2. Pick a US local number with voice enabled\n" +
      "  3. Re-run `npm run buy-number` — it will detect your new number and write it to .env.local"
    );
    process.exit(1);
  }

  if (!bought) {
    console.error("\nNone of the candidates were orderable. Try different filters (BUY_AREA_CODE, BUY_NUMBER_TYPE) or buy in the portal.");
    process.exit(1);
  }

  writeEnv(bought);
  console.log(`\nWrote ASSISTANT_PHONE_NUMBER=${bought} to .env.local.`);
  console.log("Re-run setup.ts to bind it to the assistant.");
}

main().catch((err) => {
  console.error("\nBuy failed:", err.message);
  process.exit(1);
});
