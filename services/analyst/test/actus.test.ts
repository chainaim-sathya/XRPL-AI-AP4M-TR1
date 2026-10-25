/**
 * Contract documents -> terms -> ACTUS (src/actus.ts, scripts/contract-cashflows.ts), with stand-ins for the gateway
 * (the model that reads the document) and for ACTUS; no network. The documents are the generated demo contracts.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildContract, firstPayload, intentChecks, mentorRequest, parseTerms, scheduleChecks, termsInDocument, type Terms } from "../src/actus.ts";

const run = promisify(execFile);
const script = (n: string) => fileURLToPath(new URL(`../scripts/${n}`, import.meta.url));
const root = mkdtempSync(join(tmpdir(), "analyst-actus-"));
const folder = join(root, "jupiter");
before(async () => { await run(process.execPath, [script("make-finance-fixtures.ts"), "--kind", "smb", "--out", folder, "--ar-ap", "erpnext"]); });
after(() => rmSync(root, { recursive: true, force: true }));
const doc = (n: string) => readFileSync(join(folder, "contracts", n), "utf8");
const HARBOR: Terms = { contractType: "ANN", notional: 120000, currency: "USD", annualRate: 0.095, startDate: "2025-06-15", termMonths: 36, dayCount: "30E360" };
const IF: Terms = { contractType: "PAM", notional: 30000, currency: "USD", annualRate: 0.1, startDate: "2026-09-15", maturityDate: "2026-12-15", dayCount: "A365" };
const WC: Terms = { contractType: "ANN", notional: 50000, currency: "USD", annualRate: 0.12, startDate: "2026-11-02", termMonths: 3 };

describe("terms are checked against the document", () => {
  it("the three demo contracts: the right terms pass", () => {
    assert.deepEqual(termsInDocument(HARBOR, doc("equipment_term_loan_harbor.md")), []);
    assert.deepEqual(termsInDocument(IF, doc("invoice_finance_advance_kestrel.md")), []);
    assert.deepEqual(termsInDocument(WC, doc("working_capital_loan_proposal_kestrel.md")), []);
  });
  it("a made-up amount, rate, date or repayment kind is refused", () => {
    const d = doc("working_capital_loan_proposal_kestrel.md");
    assert.match(termsInDocument({ ...WC, notional: 55000 }, d).join(), /notional 55000/);
    assert.match(termsInDocument({ ...WC, annualRate: 0.125 }, d).join(), /rate 12.5%/);
    assert.match(termsInDocument({ ...WC, startDate: "2026-11-03" }, d).join(), /start date/);
    assert.match(termsInDocument({ ...WC, contractType: "PAM" }, d).join(), /PAM/);
    assert.match(termsInDocument({ ...IF, contractType: "ANN" }, doc("invoice_finance_advance_kestrel.md")).join(), /ANN/);
  });
  it("a maturity date the document does not write out passes only when it is start + a stated term (Bedrock, 2026-10-24)", () => {
    const d = doc("equipment_term_loan_harbor.md");
    assert.deepEqual(termsInDocument({ ...HARBOR, maturityDate: "2028-06-15" }, d), []);
    assert.match(termsInDocument({ ...HARBOR, maturityDate: "2026-05-15" }, d).join(), /maturity date 2026-05-15/);
    assert.match(termsInDocument({ ...HARBOR, termMonths: undefined, maturityDate: "2028-06-15" }, d).join(), /no term in months/);
  });
  it("reads common spellings of the two kinds (annuity, amortising -> ANN; bullet -> PAM)", () => {
    for (const [w, k] of [["Annuity", "ANN"], ["amortising", "ANN"], ["Bullet", "PAM"], ["ann", "ANN"]]) assert.equal(parseTerms(JSON.stringify({ contractType: w, notional: 1, annualRate: 0.1, startDate: "2026-01-01", termMonths: 3 })).contractType, k);
  });
  it("reads the model's JSON: rate in percent, day-count spellings", () => {
    const t = parseTerms('```json\n{"contractType":"pam","notional":30000,"currency":"usd","annualRate":10,"startDate":"2026-09-15","maturityDate":"2026-12-15","dayCount":"Actual/365"}\n```');
    assert.deepEqual(t, { contractType: "PAM", notional: 30000, currency: "USD", annualRate: 0.1, startDate: "2026-09-15", maturityDate: "2026-12-15", dayCount: "A365" });
    assert.equal(parseTerms('{"contractType":"ANN","notional":1,"annualRate":0.1,"startDate":"2026-01-01","termMonths":3,"dayCount":"30/360"}').dayCount, "30E360");
    assert.throws(() => parseTerms("I cannot help"), /did not return JSON/);
  });
});

describe("contract, Mentor request and checks", () => {
  it("builds ANN and PAM like the ACTUS examples", () => {
    const a = buildContract(WC).contracts[0] as any, p = buildContract(IF).contracts[0] as any;
    assert.deepEqual([a.contractType, a.maturityDate, a.cycleOfPrincipalRedemption, a.cycleAnchorDateOfPrincipalRedemption, a.dayCountConvention], ["ANN", "2027-02-02T00:00:00", "P1ML0", "2026-12-02T00:00:00", "30E360"]);
    assert.deepEqual([p.contractType, p.maturityDate, p.dayCountConvention, p.cycleOfPrincipalRedemption], ["PAM", "2026-12-15T00:00:00", "A365", undefined]);
  });
  it("Mentor gets the terms only, and its contract is checked against them", () => {
    const text = mentorRequest(WC);
    assert.match(text, /ANN contract .* notionalPrincipal 50000 USD, fixed nominalInterestRate 0.12, initialExchangeDate 2026-11-02, maturityDate 2027-02-02/);
    assert.doesNotMatch(text, /Kestrel|Jupiter|Northline/);
    const good = buildContract(WC);
    assert.ok(intentChecks(good, WC).every(([, ok]) => ok));
    const wrong = structuredClone(good); (wrong.contracts[0] as any).nominalInterestRate = 0.012;
    assert.deepEqual(intentChecks(wrong, WC).filter(([, ok]) => !ok).map(([n]) => n), ["rate as asked"]);
    assert.deepEqual(firstPayload('Here it is:\n```json\n{"contracts":[{"contractType":"ANN"}],"riskFactors":[]}\n```\nPOST it.'), { contracts: [{ contractType: "ANN" }], riskFactors: [] });
  });
  it("schedule checks catch a 200 with a failure inside", () => {
    assert.equal(scheduleChecks({ contractID: "x", status: "Failure", events: [] }, 1, "2026-01-01")[0][1], false);
  });
});

describe("contract-cashflows.ts with stand-ins (gateway reads the document, ACTUS answers)", () => {
  let gw: Server, actus: Server, gwUrl = "", actusUrl = "", sentToModel = "", sentToActus: any[] = [];
  const replyFor: Record<string, Terms> = { "Equipment": HARBOR, "Invoice Finance": IF, "Working-Capital": WC };
  before(async () => {
    gw = createServer(async (req, res) => { let b = ""; for await (const c of req) b += c; const j = JSON.parse(b); sentToModel += j.messages[1].content;
      const k = Object.keys(replyFor).find((x) => j.messages[1].content.includes(x))!;
      // The proposal's amount is always wrong (refused after the retry); the equipment loan is first read as PAM, then corrected
      // once the failed checks come back (seen live with Bedrock on 2026-10-24).
      const retry = j.messages.length > 2;
      const t = k === "Working-Capital" ? { ...replyFor[k], notional: 55000 } : k === "Equipment" && !retry ? { ...replyFor[k], contractType: "PAM" } : replyFor[k];
      res.writeHead(200, { "content-type": "application/json", "x-chainaim-model": "local/stub", "x-chainaim-zone": "local" }); res.end(JSON.stringify({ choices: [{ message: { content: "```json\n" + JSON.stringify(t) + "\n```" } }] })); });
    actus = createServer(async (req, res) => { let b = ""; for await (const c of req) b += c; const p = JSON.parse(b); sentToActus.push(p); const c = p.contracts[0];
      const ev = [{ type: "IED", time: c.initialExchangeDate.slice(0, 16), payoff: c.notionalPrincipal, currency: "USD", nominalValue: -c.notionalPrincipal, nominalRate: c.nominalInterestRate },
        { type: "IP", time: c.maturityDate.slice(0, 16), payoff: -100, currency: "USD", nominalValue: -c.notionalPrincipal, nominalRate: c.nominalInterestRate },
        { type: "MD", time: c.maturityDate.slice(0, 16), payoff: -c.notionalPrincipal, currency: "USD", nominalValue: 0, nominalRate: c.nominalInterestRate }];
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify([{ contractID: c.contractID, status: "Success", message: "", events: ev }])); });
    for (const s of [gw, actus]) await new Promise<void>((ok) => s.listen(0, "127.0.0.1", () => ok()));
    gwUrl = `http://127.0.0.1:${(gw.address() as any).port}`; actusUrl = `http://127.0.0.1:${(actus.address() as any).port}`;
    writeFileSync(join(root, "key.txt"), "test-key");
  });
  after(() => { gw.close(); actus.close(); });

  it("reads every contract, refuses the one whose amount is not in the document, saves the others", async () => {
    const r = await run(process.execPath, [script("contract-cashflows.ts"), "--folder", folder, "--gateway", gwUrl, "--key-file", join(root, "key.txt"), "--actus-url", actusUrl, "--postman-out", join(root, "pm.json")]).catch((e) => e);
    assert.match(r.stdout, /CHECK {5}FAIL {2}notional 55000 is not in the document/);
    assert.match(r.stdout, /REFUSED {3}a term is not in the document; nothing was sent to ACTUS/);
    assert.match(r.stdout, /CHECK {5}FAIL {2}PAM \(one repayment at the end\) is not what the document describes[\s\S]*TERMS {5}re-read by local\/stub/, "the equipment loan was corrected on the retry");
    assert.equal(sentToActus.length, 2, "only the two checked contracts reached ACTUS");
    assert.ok(sentToActus.every((p) => !/Kestrel|Harbor|Jupiter/.test(JSON.stringify(p))), "no party names go to ACTUS");
    const csv = readFileSync(join(folder, "loan_schedules.csv"), "utf8").trim().split("\n");
    assert.equal(csv[0], "Contract ID,Source,Date,Event,Event Name,Payoff,Currency,Principal After,Rate");
    assert.deepEqual([...new Set(csv.slice(1).map((l) => l.split(",")[0]))].sort(), ["EQUIPMENT-TERM-LOAN-HARBOR", "INVOICE-FINANCE-ADVANCE-KESTREL"]);
    assert.equal(JSON.parse(readFileSync(join(root, "pm.json"), "utf8")).item.length, 2);
  });
  it("--terms-json for one document calls no model, and replaces only that contract's rows", async () => {
    const before = sentToModel.length;
    await run(process.execPath, [script("contract-cashflows.ts"), "--folder", folder, "--file", join(folder, "contracts", "working_capital_loan_proposal_kestrel.md"), "--terms-json", JSON.stringify(WC), "--actus-url", actusUrl]);
    assert.equal(sentToModel.length, before);
    const ids = readFileSync(join(folder, "loan_schedules.csv"), "utf8").trim().split("\n").slice(1).map((l) => l.split(",")[0]);
    assert.deepEqual([...new Set(ids)].sort(), ["EQUIPMENT-TERM-LOAN-HARBOR", "INVOICE-FINANCE-ADVANCE-KESTREL", "WORKING-CAPITAL-LOAN-PROPOSAL-KESTREL"]);
  });
});
