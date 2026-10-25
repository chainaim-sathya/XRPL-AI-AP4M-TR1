/**
 * A loan's cash-flow schedule from ACTUS, saved as a CSV next to the books so cross-file questions can use it
 * (e.g. "can we repay this loan from the cash we collect?"). Only the LOAN TERMS leave this PC — never the books.
 *
 *   node scripts/actus-schedule.ts --notional 50000 --rate 0.12 --start 2026-11-02 --months 3 --type ANN \
 *        --actus-url http://<host>:8083 --out C:\PRIV-AI-DATA\smb\jupiter-knits\loan_schedule.csv [--postman-out file.json]
 *   node scripts/actus-schedule.ts --via mentor --text "50,000 USD working-capital loan, 12% fixed, 3 monthly payments from 2 Nov 2026" \
 *        --mentor-url http://<host> --out ...
 *
 * Terms (built here, --via direct; the contract follows the ACTUS example contracts PAM/ANN, e.g. l3ANNnoRF):
 *   --type PAM|ANN        PAM: interest, principal at maturity (a bullet); ANN: equal monthly payments   (default ANN)
 *   --notional N          loan amount                                                                    (required)
 *   --rate R              fixed annual rate as a decimal, 0.12 = 12%                                     (required)
 *   --start YYYY-MM-DD    the day the money is received (ACTUS initialExchangeDate)                     (required)
 *   --months N            term in months (maturity = start + N months)                                   (required)
 *   --role RPL|RPA        RPL = borrower (money in, then payments out; default), RPA = lender
 *   --currency USD        --day-count 30E360|A365 (default: ANN 30E360, PAM A365)   --id <contract id>
 * Plain English (--via mentor): ACTUS Mentor builds the contract with its ACTUS knowledge (POST /generate-contract),
 * then runs it on its ACTUS server (POST /run-contract). Its key is read from --mentor-key-env (default
 * ACTUS_MENTOR_API_KEY), never from a file or the command line.
 *   --text "..."  --contract-type PAM|ANN (default ANN)
 * Either way:
 *   --actus-url URL       ACTUS server for --via direct (or the ACTUS_URL environment variable); no default
 *   --mentor-url URL      ACTUS Mentor for --via mentor (or ACTUS_MENTOR_URL); no default
 *   --out FILE.csv        the schedule: Contract ID, Date, Event, Event Name, Payoff, Currency, Principal After, Rate
 *   --postman-out FILE    also write a Postman collection (v2.1) holding this exact request, to run it yourself
 *   --timeout-sec N       (default 60)    --json   print the ACTUS answer as JSON too
 * The schedule is checked before it is saved: ACTUS status Success, the first event is IED for the notional, the
 * principal paid back equals the notional, the last event is on the maturity date. A failed check saves nothing.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: f } = parseArgs({ strict: true, options: {
  via: { type: "string", default: "direct" }, type: { type: "string", default: "ANN" }, notional: { type: "string" }, rate: { type: "string" },
  start: { type: "string" }, months: { type: "string" }, role: { type: "string", default: "RPL" }, currency: { type: "string", default: "USD" },
  "day-count": { type: "string" }, id: { type: "string" }, text: { type: "string" }, "contract-type": { type: "string", default: "ANN" },
  "actus-url": { type: "string" }, "mentor-url": { type: "string" }, "mentor-key-env": { type: "string", default: "ACTUS_MENTOR_API_KEY" },
  out: { type: "string" }, "postman-out": { type: "string" }, "timeout-sec": { type: "string", default: "60" }, json: { type: "boolean", default: false },
} });
const fail = (m: string): never => { console.error(`actus-schedule: ${m}`); process.exit(2); };
const timeoutMs = Number(f["timeout-sec"]) * 1000;
if (!(timeoutMs > 0)) fail("--timeout-sec must be a positive number");
if (f.via !== "direct" && f.via !== "mentor") fail("--via must be direct or mentor");
const NAMES: Record<string, string> = { IED: "money received (initial exchange)", IP: "interest payment", PR: "principal repayment", MD: "maturity (last principal)", PRF: "payment fixing (no cash)", RR: "rate reset", FP: "fee" };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addMonths = (d: string, n: number): string => { const t = new Date(d + "T00:00:00Z"); t.setUTCMonth(t.getUTCMonth() + n); return iso(t); };

type Payload = { contracts: Record<string, unknown>[]; riskFactors: unknown[] };
function buildContract(): { payload: Payload; terms: { notional: number; maturity: string; role: string; id: string } } {
  const type = String(f.type).toUpperCase();
  if (type !== "PAM" && type !== "ANN") fail("--type must be PAM or ANN");
  const notional = Number(f.notional), rate = Number(f.rate), months = Number(f.months);
  if (!(notional > 0)) fail("--notional must be a positive number");
  if (!(rate >= 0 && rate < 1)) fail("--rate is a decimal: 0.12 means 12%");
  if (!Number.isInteger(months) || months < 1 || months > 360) fail("--months must be a whole number 1 to 360");
  if (!f.start || !/^\d{4}-\d{2}-\d{2}$/.test(f.start)) fail("--start must be YYYY-MM-DD");
  if (f.role !== "RPL" && f.role !== "RPA") fail("--role must be RPL (borrower) or RPA (lender)");
  if (!/^[A-Z]{3}$/.test(f.currency!)) fail("--currency must be a 3-letter code");
  const dayCount = f["day-count"] ?? (type === "ANN" ? "30E360" : "A365");
  if (!["30E360", "A365", "A360", "AA"].includes(dayCount)) fail("--day-count must be 30E360, A365, A360 or AA");
  const ied = f.start, deal = iso(new Date(Date.parse(ied + "T00:00:00Z") - 86400000)), maturity = addMonths(ied, months);
  const id = f.id ?? `${type}-${notional}-${ied}`;
  const c: Record<string, unknown> = {
    contractType: type, contractID: id, contractRole: f.role, statusDate: `${deal}T00:00:00`, contractDealDate: `${deal}T00:00:00`,
    initialExchangeDate: `${ied}T00:00:00`, maturityDate: `${maturity}T00:00:00`, notionalPrincipal: notional, nominalInterestRate: rate,
    currency: f.currency, dayCountConvention: dayCount,
  };
  if (type === "ANN") {
    const first = `${addMonths(ied, 1)}T00:00:00`;
    Object.assign(c, { calendar: "WEEKDAY", businessDayConvention: "SCF", cycleAnchorDateOfInterestPayment: first, cycleOfInterestPayment: "P1ML0",
      cycleAnchorDateOfPrincipalRedemption: first, cycleOfPrincipalRedemption: "P1ML0", premiumDiscountAtIED: 0 });
  }
  return { payload: { contracts: [c], riskFactors: [] }, terms: { notional, maturity, role: String(f.role), id } };
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<any> {
  let r: Response;
  try { r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) { fail(`${url}: ${(e as Error).name === "TimeoutError" ? `no answer within ${timeoutMs / 1000} s` : "not reachable"}`); }
  const text = await r!.text();
  if (!r!.ok) fail(`${url}: HTTP ${r!.status} ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { fail(`${url}: the answer is not JSON`); }
}
const firstJson = (text: string): any => { // the first {...} holding "contracts" in Mentor's generated text
  for (let i = text.indexOf("{"); i !== -1; i = text.indexOf("{", i + 1)) {
    let depth = 0;
    for (let j = i; j < text.length; j++) { if (text[j] === "{") depth++; else if (text[j] === "}" && --depth === 0) { try { const o = JSON.parse(text.slice(i, j + 1)); if (o && Array.isArray(o.contracts)) return o; } catch { /* try the next */ } break; } }
  }
  return null;
};

let payload: Payload, terms: { notional: number; maturity: string; role: string; id: string } | null = null, result: any, endpoint: string, headers: Record<string, string> = {};
if (f.via === "direct") {
  const actus = (f["actus-url"] || process.env.ACTUS_URL || fail("--actus-url (or ACTUS_URL) is required")).replace(/\/+$/, "");
  ({ payload, terms } = buildContract());
  endpoint = `${actus}/eventsBatch`;
  result = await post(endpoint, payload);
} else {
  const mentor = (f["mentor-url"] || process.env.ACTUS_MENTOR_URL || fail("--mentor-url (or ACTUS_MENTOR_URL) is required")).replace(/\/+$/, "");
  if (!f.text) fail("--text is required with --via mentor");
  const key = process.env[f["mentor-key-env"]!];
  if (key) headers = { "X-API-Key": key };
  const ct = String(f["contract-type"]).toUpperCase();
  const gen = await post(`${mentor}/generate-contract`, { contract_type: ct, with_risk_factor: false, additional_requirements: f.text }, headers);
  payload = firstJson(String(gen.generated_contract ?? "")) ?? fail("ACTUS Mentor's answer holds no {\"contracts\": [...]} JSON");
  console.log(`MENTOR    built a ${ct} contract (route ${gen.route_taken ?? "-"}, hallucination check: ${gen.hallucination_check ?? "-"})`);
  endpoint = `${mentor}/run-contract`;
  const run = await post(endpoint, { contract: payload }, headers);
  result = run.results;
}

// ---- check, then save --------------------------------------------------------------------------------
const r0 = Array.isArray(result) ? result[0] : null;
if (!r0) fail("ACTUS returned no result");
const events: any[] = r0.events ?? [];
const c0 = payload.contracts[0] as Record<string, any>;
const notional = terms?.notional ?? Number(c0.notionalPrincipal), maturity = terms?.maturity ?? String(c0.maturityDate).slice(0, 10);
const checks: [string, boolean][] = [
  ["ACTUS status Success", r0.status === "Success"],
  ["first event is IED for the notional", events[0]?.type === "IED" && Math.abs(Math.abs(events[0].payoff) - notional) < 0.01],
  ["principal paid back equals the notional", Math.abs(events.filter((e) => e.type === "PR" || e.type === "MD").reduce((n, e) => n + Math.abs(e.payoff), 0) - notional) < 0.05],
  ["last event on the maturity date", String(events.at(-1)?.time ?? "").slice(0, 10) === maturity],
];
console.log(`ACTUS     ${endpoint}: ${r0.status}${r0.message ? ` (${r0.message})` : ""}, ${events.length} events`);
for (const [name, ok] of checks) console.log(`CHECK     ${ok ? "pass" : "FAIL"}  ${name}`);
const rows = events.filter((e) => e.type !== "PRF").map((e) => [r0.contractID, String(e.time).slice(0, 10), e.type, NAMES[e.type] ?? e.type, Number(e.payoff).toFixed(2), e.currency, Math.abs(Number(e.nominalValue)).toFixed(2), e.nominalRate]);
console.log("\nDate        Event  Payoff        Principal after");
for (const x of rows) console.log(`${x[1]}  ${String(x[2]).padEnd(5)}  ${String(x[4]).padStart(12)}  ${String(x[6]).padStart(12)}`);
const totalOut = events.filter((e) => e.payoff < 0).reduce((n, e) => n + e.payoff, 0), interest = events.filter((e) => e.type === "IP").reduce((n, e) => n + Math.abs(e.payoff), 0);
console.log(`\nTotal paid back ${Math.abs(totalOut).toFixed(2)} of which interest ${interest.toFixed(2)}`);
if (f.json) console.log(JSON.stringify(result, null, 2));
if (f["postman-out"]) {
  const body = f.via === "direct" ? payload : { contract: payload };
  const url = new URL(endpoint);
  const collection = { info: { name: `ChainAim ACTUS — ${r0.contractID}`, schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    description: "Loan terms only (no books). Made by services/analyst/scripts/actus-schedule.ts." },
    variable: [{ key: "base", value: url.origin }],
    item: [{ name: `${f.via === "direct" ? "eventsBatch" : "run-contract"} ${r0.contractID}`, request: { method: "POST",
      header: [{ key: "Content-Type", value: "application/json" }, ...(f.via === "mentor" ? [{ key: "X-API-Key", value: "{{mentorApiKey}}" }] : [])],
      body: { mode: "raw", raw: JSON.stringify(body, null, 2), options: { raw: { language: "json" } } },
      url: { raw: `{{base}}${url.pathname}`, host: ["{{base}}"], path: url.pathname.split("/").filter(Boolean) } } }] };
  writeFileSync(f["postman-out"], JSON.stringify(collection, null, 2) + "\n");
  console.log(`POSTMAN   ${f["postman-out"]} (import it in Postman; base = ${url.origin})`);
}
if (checks.some(([, ok]) => !ok)) { console.log("\nNot saved: a check failed."); process.exit(1); }
if (f.out) {
  const cell = (v: unknown) => { const x = String(v ?? ""); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
  writeFileSync(f.out, ["Contract ID,Date,Event,Event Name,Payoff,Currency,Principal After,Rate", ...rows.map((x) => x.map(cell).join(","))].join("\n") + "\n");
  console.log(`SAVED     ${f.out} (${rows.length} rows)`);
}
