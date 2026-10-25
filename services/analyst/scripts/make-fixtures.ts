/**
 * Synthetic practice-management data with known problems planted, for tests and demos. Every name is made up.
 *
 *   node scripts/make-fixtures.ts --out <folder> [--production-rows 8000] [--months 9] [--start 2026-01]
 *        [--leak-start 2026-06] [--leak-rate 0.25] [--payer-drop-start 2026-07] [--duplicates 2] [--seed 42]
 *
 * Writes production.csv (charges), collections.csv (payments posted) and bank.csv (deposits and some withdrawals).
 * Card payments are deposited as one daily batch the next day; checks and ACH payments one by one.
 * Planted: from --leak-start, a --leak-rate share of card batches never reach the bank; from --payer-drop-start one
 * payer ("Northwind Dental Plan") pays far less often; --duplicates payment rows are posted twice.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: f } = parseArgs({
  options: {
    out: { type: "string" },
    "production-rows": { type: "string", default: "8000" },
    months: { type: "string", default: "9" },
    start: { type: "string", default: "2026-01" },
    "leak-start": { type: "string", default: "2026-06" },
    "leak-rate": { type: "string", default: "0.25" },
    "payer-drop-start": { type: "string", default: "2026-07" },
    duplicates: { type: "string", default: "2" },
    seed: { type: "string", default: "42" },
  },
});
if (!f.out) throw new Error("--out <folder> is required");
const N = Number(f["production-rows"]), months = Number(f.months), leakRate = Number(f["leak-rate"]), dups = Number(f.duplicates);
if (![N, months, leakRate, dups].every(Number.isFinite)) throw new Error("numeric flags must be numbers");

// Deterministic PRNG (mulberry32), so the same seed always gives the same files.
let s = Number(f.seed) >>> 0;
const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
const day = 86400000;
const startMs = Date.parse(`${f.start}-01T00:00:00Z`);
const endMs = Date.UTC(new Date(startMs).getUTCFullYear(), new Date(startMs).getUTCMonth() + months, 1) - day;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const us = (ms: number) => { const d = new Date(ms); return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`; };
const cents = (v: number) => (Math.round(v * 100) / 100).toFixed(2);
const csv = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

const first = ["Asha", "Ben", "Chloe", "Dev", "Ella", "Farid", "Gita", "Hugo", "Isla", "Jai", "Kira", "Leo", "Maya", "Nik", "Omar", "Pia", "Ravi", "Sara", "Tom", "Uma"];
const last = ["Rao", "Smith", "Iyer", "Khan", "Lopez", "Chen", "Patel", "Nair", "Brown", "Das"];
const payers = ["Northwind Dental Plan", "Contoso Health", "Fabrikam Mutual", "Self-pay", "Tailspin Benefits"];
const cpt = [["D0120", 85], ["D1110", 120], ["D0274", 95], ["D2391", 210], ["D2740", 1150], ["D7140", 260]] as const;

const production: string[] = ["Service Date,Patient,Payer,Claim #,CPT,Charge"];
const payments: { ms: number; patient: string; payer: string; claim: string; method: string; amt: number }[] = [];
const leakFrom = Date.parse(`${f["leak-start"]}-01T00:00:00Z`), dropFrom = Date.parse(`${f["payer-drop-start"]}-01T00:00:00Z`);
for (let i = 0; i < N; i++) {
  const ms = startMs + Math.floor(rnd() * ((endMs - startMs) / day + 1)) * day;
  const patient = `${pick(first)} ${pick(last)}`, payer = pick(payers), claim = `CLM-${100000 + i}`, [code, base] = pick([...cpt]);
  const charge = base * (0.9 + rnd() * 0.25);
  production.push([us(ms), patient, payer, claim, code, cents(charge)].map(csv).join(","));
  const payRate = payer === "Northwind Dental Plan" && ms >= dropFrom ? 0.55 : 0.95;
  if (rnd() > payRate) continue;
  const lag = (payer === "Self-pay" ? 0 : 10 + Math.floor(rnd() * 30)) * day;
  const pms = ms + lag;
  if (pms > endMs) continue;
  const method = payer === "Self-pay" ? pick(["CARD", "CARD", "CHECK"]) : pick(["EFT", "EFT", "CARD", "CHECK"]);
  payments.push({ ms: pms, patient, payer, claim, method, amt: charge * (payer === "Self-pay" ? 1 : 0.62 + rnd() * 0.25) });
}
payments.sort((a, b) => a.ms - b.ms);
for (let d = 0; d < dups && payments.length; d++) payments.splice(Math.floor(rnd() * payments.length), 0, { ...payments[Math.floor(rnd() * payments.length)] });
const collections = ["Posted Date,Patient,Payer,Claim #,Method,Paid Amount", ...payments.map((p) => [us(p.ms), p.patient, p.payer, p.claim, p.method, cents(p.amt)].map(csv).join(","))];

// Bank: card payments settle as one batch the next day; checks and EFT one by one (checks a day later).
const bank: { ms: number; desc: string; amt: number }[] = [];
const cardByDay = new Map<number, number>();
for (const p of payments) {
  if (p.method === "CARD") cardByDay.set(p.ms, (cardByDay.get(p.ms) ?? 0) + Math.round(p.amt * 100) / 100);
  else bank.push({ ms: p.ms + (p.method === "CHECK" ? day : 0), desc: p.method === "CHECK" ? `DEPOSIT CHECK ${p.claim}` : `ACH CREDIT ${p.payer.toUpperCase()}`, amt: p.amt });
}
let batch = 0;
for (const [ms, amt] of [...cardByDay.entries()].sort((a, b) => a[0] - b[0])) {
  batch++;
  if (ms >= leakFrom && rnd() < leakRate) continue; // planted leak: this batch never arrives
  bank.push({ ms: ms + day, desc: `CARD SETTLEMENT BATCH ${batch}`, amt });
}
for (let m = 0; m < months; m++) {
  const first = Date.UTC(new Date(startMs).getUTCFullYear(), new Date(startMs).getUTCMonth() + m, 1);
  bank.push({ ms: first + 2 * day, desc: "RENT PAYMENT LANDLORD LLC", amt: -6500 }, { ms: first + 14 * day, desc: "PAYROLL", amt: -18250 });
}
bank.sort((a, b) => a.ms - b.ms);
const bankCsv = ["Date,Description,Amount", ...bank.filter((b) => b.ms <= endMs + 3 * day).map((b) => [iso(b.ms), b.desc, cents(b.amt)].map(csv).join(","))];

mkdirSync(f.out, { recursive: true });
writeFileSync(join(f.out, "production.csv"), production.join("\n") + "\n");
writeFileSync(join(f.out, "collections.csv"), collections.join("\n") + "\n");
writeFileSync(join(f.out, "bank.csv"), bankCsv.join("\n") + "\n");
console.log(`wrote ${f.out}: production ${production.length - 1} rows, collections ${collections.length - 1}, bank ${bankCsv.length - 1}`);
