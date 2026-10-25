/**
 * ACTUS cash flows for fixed-rate loans (the XRPL Lending Protocol's kind: fixed rate, fixed term):
 * terms -> an ACTUS contract (PAM = bullet, ANN = equal instalments), run on ACTUS directly or through ACTUS Mentor
 * (which builds the contract with its ACTUS knowledge), checked, and turned into schedule rows.
 * Also: terms read from a contract document by a model, then checked against the document's own text, so a value the
 * model made up never reaches ACTUS. Pure apart from fetch; no file access here.
 */
export type ContractType = "PAM" | "ANN";
export type Terms = {
  contractType: ContractType; notional: number; currency: string; annualRate: number; startDate: string;
  maturityDate?: string; termMonths?: number; dayCount?: string; role?: "RPL" | "RPA"; id?: string;
};
export type Payload = { contracts: Record<string, unknown>[]; riskFactors: unknown[] };
export type ActusEvent = { type: string; time: string; payoff: number; currency: string; nominalValue: number; nominalRate: number };
export type ActusResult = { contractID: string; status: string; message?: string; events: ActusEvent[] };
export const EVENT_NAMES: Record<string, string> = { IED: "money received (initial exchange)", IP: "interest payment", PR: "principal repayment", MD: "maturity (last principal)", PRF: "payment fixing (no cash)", RR: "rate reset", FP: "fee" };

const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);
export const addMonths = (d: string, n: number): string => { const t = new Date(d + "T00:00:00Z"); t.setUTCMonth(t.getUTCMonth() + n); return iso(t.getTime()); };
export const maturityOf = (t: Terms): string => t.maturityDate ?? addMonths(t.startDate, t.termMonths ?? NaN);

/** Throws a plain message when terms are incomplete or out of range. */
export function checkTerms(t: Terms): Terms {
  const bad = (m: string): never => { throw new Error(`terms: ${m}`); };
  if (t.contractType !== "PAM" && t.contractType !== "ANN") bad("contractType must be PAM (bullet) or ANN (equal instalments)");
  if (!(t.notional > 0)) bad("notional must be above 0");
  if (!(t.annualRate >= 0 && t.annualRate < 1)) bad("annualRate is a decimal: 0.12 means 12%");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.startDate ?? "")) bad("startDate must be YYYY-MM-DD");
  if (t.maturityDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(t.maturityDate)) bad("maturityDate must be YYYY-MM-DD");
  if (t.maturityDate === undefined && !(Number.isInteger(t.termMonths) && t.termMonths! >= 1 && t.termMonths! <= 360)) bad("give maturityDate or termMonths (1 to 360)");
  if (maturityOf(t) <= t.startDate) bad("maturity must be after the start");
  if (!/^[A-Z]{3}$/.test(t.currency ?? "")) bad("currency must be a 3-letter code");
  if (t.dayCount !== undefined && !["30E360", "A365", "A360", "AA"].includes(t.dayCount)) bad("dayCount must be 30E360, A365, A360 or AA");
  if (t.role !== undefined && t.role !== "RPL" && t.role !== "RPA") bad("role must be RPL (borrower) or RPA (lender)");
  return t;
}

/** The ACTUS contract, in the shape of the ACTUS example contracts (l3PAMnoRF / l3ANNnoRF). */
export function buildContract(t: Terms): Payload {
  checkTerms(t);
  const deal = iso(Date.parse(t.startDate + "T00:00:00Z") - 86400000), maturity = maturityOf(t);
  const c: Record<string, unknown> = {
    contractType: t.contractType, contractID: t.id ?? `${t.contractType}-${t.notional}-${t.startDate}`, contractRole: t.role ?? "RPL",
    statusDate: `${deal}T00:00:00`, contractDealDate: `${deal}T00:00:00`, initialExchangeDate: `${t.startDate}T00:00:00`, maturityDate: `${maturity}T00:00:00`,
    notionalPrincipal: t.notional, nominalInterestRate: t.annualRate, currency: t.currency, dayCountConvention: t.dayCount ?? (t.contractType === "ANN" ? "30E360" : "A365"),
  };
  if (t.contractType === "ANN") {
    const first = `${addMonths(t.startDate, 1)}T00:00:00`;
    Object.assign(c, { calendar: "WEEKDAY", businessDayConvention: "SCF", cycleAnchorDateOfInterestPayment: first, cycleOfInterestPayment: "P1ML0",
      cycleAnchorDateOfPrincipalRedemption: first, cycleOfPrincipalRedemption: "P1ML0", premiumDiscountAtIED: 0 });
  }
  return { contracts: [c], riskFactors: [] };
}

/** The plain-English request ACTUS Mentor gets: the checked terms only (no party names, no books). */
export function mentorRequest(t: Terms): string {
  const m = maturityOf(t);
  return `${t.contractType} contract for a borrower (contractRole RPL): notionalPrincipal ${t.notional} ${t.currency}, fixed nominalInterestRate ${t.annualRate}, `
    + `initialExchangeDate ${t.startDate}, maturityDate ${m}, dayCountConvention ${t.dayCount ?? (t.contractType === "ANN" ? "30E360" : "A365")}, `
    + (t.contractType === "ANN" ? `monthly principal and interest (cycle P1ML0) starting ${addMonths(t.startDate, 1)}, ` : "interest and principal paid at maturity, ")
    + `no risk factors. Return the eventsBatch body {"contracts":[...],"riskFactors":[]}.`;
}

/** Checks a contract (e.g. one ACTUS Mentor built) against the terms it was asked for: the intent check. */
export function intentChecks(p: Payload, t: Terms): [string, boolean][] {
  const c = (p.contracts?.[0] ?? {}) as Record<string, any>;
  const day = (v: unknown) => String(v ?? "").slice(0, 10);
  return [
    ["contract type as asked", c.contractType === t.contractType],
    ["notional as asked", Number(c.notionalPrincipal) === t.notional],
    ["rate as asked", Math.abs(Number(c.nominalInterestRate) - t.annualRate) < 1e-9],
    ["start date as asked", day(c.initialExchangeDate) === t.startDate],
    ["maturity date as asked", day(c.maturityDate) === maturityOf(t)],
  ];
}

/** Checks ACTUS's answer before anything is saved. */
export function scheduleChecks(r: ActusResult | undefined, notional: number, maturity: string): [string, boolean][] {
  const ev = r?.events ?? [];
  return [
    ["ACTUS status Success", r?.status === "Success"],
    ["first event is IED for the notional", ev[0]?.type === "IED" && Math.abs(Math.abs(ev[0].payoff) - notional) < 0.01],
    ["principal paid back equals the notional", Math.abs(ev.filter((e) => e.type === "PR" || e.type === "MD").reduce((n, e) => n + Math.abs(e.payoff), 0) - notional) < 0.05],
    ["last event on the maturity date", String(ev.at(-1)?.time ?? "").slice(0, 10) === maturity],
  ];
}

export const SCHEDULE_HEADER = ["Contract ID", "Source", "Date", "Event", "Event Name", "Payoff", "Currency", "Principal After", "Rate"];
export function scheduleRows(r: ActusResult, source: string): (string | number)[][] {
  return r.events.filter((e) => e.type !== "PRF").map((e) => [r.contractID, source, String(e.time).slice(0, 10), e.type, EVENT_NAMES[e.type] ?? e.type, Number(e.payoff).toFixed(2), e.currency, Math.abs(Number(e.nominalValue)).toFixed(2), e.nominalRate]);
}

// ---- HTTP ------------------------------------------------------------------------------------------------
async function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number): Promise<any> {
  let r: Response;
  try { r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) { throw new Error(`${url}: ${(e as Error).name === "TimeoutError" ? `no answer within ${timeoutMs / 1000} s` : "not reachable"}`); }
  const text = await r.text();
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status} ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { throw new Error(`${url}: the answer is not JSON`); }
}
export async function runDirect(actusUrl: string, payload: Payload, timeoutMs: number): Promise<ActusResult[]> {
  return postJson(`${actusUrl.replace(/\/+$/, "")}/eventsBatch`, payload, {}, timeoutMs);
}
/** The first {...} holding "contracts" in a text (ACTUS Mentor's generated answer). */
export function firstPayload(text: string): Payload | null {
  for (let i = text.indexOf("{"); i !== -1; i = text.indexOf("{", i + 1)) {
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}" && --depth === 0) { try { const o = JSON.parse(text.slice(i, j + 1)); if (o && Array.isArray(o.contracts)) return o; } catch { /* next */ } break; }
    }
  }
  return null;
}
export async function mentorBuild(mentorUrl: string, key: string | undefined, t: Terms, timeoutMs: number): Promise<{ payload: Payload; route: string; hallucinationCheck: string }> {
  const gen = await postJson(`${mentorUrl.replace(/\/+$/, "")}/generate-contract`, { contract_type: t.contractType, with_risk_factor: false, additional_requirements: mentorRequest(t) }, key ? { "X-API-Key": key } : {}, timeoutMs);
  const payload = firstPayload(String(gen.generated_contract ?? ""));
  if (!payload) throw new Error("ACTUS Mentor's answer holds no {\"contracts\": [...]} JSON");
  return { payload, route: String(gen.route_taken ?? "-"), hallucinationCheck: String(gen.hallucination_check ?? "-") };
}
export async function mentorRun(mentorUrl: string, key: string | undefined, payload: Payload, timeoutMs: number): Promise<ActusResult[]> {
  const r = await postJson(`${mentorUrl.replace(/\/+$/, "")}/run-contract`, { contract: payload }, key ? { "X-API-Key": key } : {}, timeoutMs);
  return r.results;
}

// ---- terms from a contract document ---------------------------------------------------------------------
export const TERMS_SYSTEM = [
  "You read a loan or financing document and return its terms as JSON only, in a ```json block, with these keys:",
  '{"contractType": "ANN" when the loan is repaid in equal (monthly) instalments of principal and interest, e.g. "36 equal monthly instalments";',
  ' "PAM" only when the whole principal is repaid in ONE payment at the end (a bullet),',
  ' "notional": number, "currency": "USD", "annualRate": decimal (12% -> 0.12), "startDate": "YYYY-MM-DD" (drawdown / advance date),',
  ' "maturityDate": "YYYY-MM-DD" if the document states the final date, "termMonths": integer if it states a term in months,',
  ' "dayCount": "30E360" for 30/360, "A365" for actual/365, omitted if not stated}',
  "Copy numbers and dates exactly from the document. If a value is not in the document, leave the key out. No other text.",
].join("\n");
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
/** Parses the model's JSON. */
export function parseTerms(text: string): Terms {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (m ? m[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)).trim();
  let o: any;
  try { o = JSON.parse(raw); } catch { throw new Error("the model did not return JSON terms"); }
  // Common spellings of the two kinds (seen live: a first answer that was neither "PAM" nor "ANN").
  const kind = String(o.contractType ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  const KINDS: Record<string, ContractType> = { ANN: "ANN", ANNUITY: "ANN", AMORTIZING: "ANN", AMORTISING: "ANN", AMORTIZINGLOAN: "ANN", AMORTISINGLOAN: "ANN", INSTALMENT: "ANN", INSTALLMENT: "ANN",
    PAM: "PAM", BULLET: "PAM", BULLETLOAN: "PAM", PRINCIPALATMATURITY: "PAM" };
  const t: Terms = { contractType: (KINDS[kind] ?? kind) as ContractType, notional: Number(o.notional), currency: String(o.currency ?? "USD").toUpperCase(),
    annualRate: Number(o.annualRate), startDate: String(o.startDate ?? "") };
  if (o.maturityDate) t.maturityDate = String(o.maturityDate);
  if (o.termMonths !== undefined && o.termMonths !== null) t.termMonths = Number(o.termMonths);
  if (o.dayCount) {
    const d = String(o.dayCount).toUpperCase().replace(/[^A-Z0-9]/g, "");
    t.dayCount = /^30E?360$/.test(d) ? "30E360" : /^(A|ACT|ACTUAL)365(F|FIXED)?$/.test(d) ? "A365" : /^(A|ACT|ACTUAL)360$/.test(d) ? "A360" : /^(AA|ACTACT|ACTUALACTUAL)$/.test(d) ? "AA" : d;
  }
  if (t.annualRate >= 1) t.annualRate = t.annualRate / 100; // "12" meant 12%
  return t;
}
/**
 * Every value must be found in the document itself; a made-up value is refused. Returns failed checks (empty = ok).
 * Dates may be written as 2026-11-02 or "2 November 2026"; rates as 12%, 12.00% or 9.50%; amounts with or without commas.
 */
export function termsInDocument(t: Terms, doc: string): string[] {
  const text = doc.toLowerCase(), flat = text.replace(/,/g, "");
  const failed: string[] = [];
  const hasNumber = (n: number) => new RegExp(`(^|[^0-9.])${String(n).replace(".", "\\.")}(\\.0+)?([^0-9]|$)`).test(flat);
  const hasDate = (d: string) => { const [y, mo, da] = d.split("-").map(Number); return text.includes(d) || text.includes(`${da} ${MONTHS[mo - 1]} ${y}`) || text.includes(`${MONTHS[mo - 1]} ${da}, ${y}`); };
  if (!hasNumber(t.notional)) failed.push(`notional ${t.notional} is not in the document`);
  const pct = Math.round(t.annualRate * 10000) / 100;
  const pctRe = Number.isInteger(pct) ? `${pct}(\\.0+)?` : `${String(pct).replace(".", "\\.")}0*`;
  if (!new RegExp(`(^|[^0-9.])${pctRe}\\s*(%|per ?cent)`).test(flat)) failed.push(`rate ${pct}% is not in the document`);
  if (!hasDate(t.startDate)) failed.push(`start date ${t.startDate} is not in the document`);
  // A maturity date the document does not write out is accepted only when it is exactly start + a term the document states.
  const termStated = (m: number | undefined) => m !== undefined && (hasNumber(m) || (m <= 12 && new RegExp(`\\b${WORDS[m]}\\b`).test(text)));
  if (t.maturityDate && !hasDate(t.maturityDate) && !(termStated(t.termMonths) && addMonths(t.startDate, t.termMonths!) === t.maturityDate)) failed.push(`maturity date ${t.maturityDate} is not in the document${t.termMonths ? "" : " (and no term in months was given)"}`);
  if (!t.maturityDate && t.termMonths && !(hasNumber(t.termMonths) || (t.termMonths <= 12 && new RegExp(`\\b${WORDS[t.termMonths]}\\b`).test(text)))) failed.push(`term of ${t.termMonths} months is not in the document`);
  const equal = /equal\b[^.]*\binstal?ments?|annuity/.test(text), single = /single payment|in one payment|bullet|repayable in full|together with all accrued interest on/.test(text);
  if (t.contractType === "ANN" && !equal) failed.push("ANN (equal instalments) is not what the document describes");
  if (t.contractType === "PAM" && !single) failed.push("PAM (one repayment at the end) is not what the document describes");
  return failed;
}
