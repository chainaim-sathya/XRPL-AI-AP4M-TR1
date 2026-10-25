/**
 * The Private CFO AI demo data and the ACTUS step: scripts/make-finance-fixtures.ts (related synthetic CSVs, row cap)
 * and scripts/actus-schedule.ts against a stand-in ACTUS server (no network): the contract it sends, the checks
 * before saving, the CSV and the Postman collection.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openDb } from "../src/db.ts";
import { profileFolder } from "../src/profile.ts";
import { loadAndRelate } from "../src/relate.ts";

const run = promisify(execFile);
const script = (name: string) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const root = mkdtempSync(join(tmpdir(), "analyst-fin-"));
after(() => rmSync(root, { recursive: true, force: true }));
const lines = (p: string) => readFileSync(p, "utf8").trim().split("\n");

async function relationsOf(folder: string) {
  const profs = await profileFolder(folder, { allowedRoots: [root], exclude: [], hideFolders: [], workDir: join(root, "_w") }, 20, 5e8, openDb);
  const db = await openDb();
  try { return (await loadAndRelate(db, profs)).relations.map((r) => `${r.a.table}.${r.a.column}~${r.b.table}.${r.b.column}:${r.link}`); } finally { db.close(); }
}

describe("make-finance-fixtures", () => {
  it("smb: eight related files, every file within --max-rows, the same files for the same seed", async () => {
    const a = join(root, "smb-a"), b = join(root, "smb-b");
    await run(process.execPath, [script("make-finance-fixtures.ts"), "--kind", "smb", "--out", a, "--max-rows", "300"]);
    await run(process.execPath, [script("make-finance-fixtures.ts"), "--kind", "smb", "--out", b, "--max-rows", "300"]);
    const files = readdirSync(a).filter((n) => n.endsWith(".csv")).sort();
    assert.deepEqual(readdirSync(join(a, "contracts")).sort(), ["equipment_term_loan_harbor.md", "invoice_finance_advance_kestrel.md", "working_capital_loan_proposal_kestrel.md"]);
    assert.deepEqual(files, ["bank.csv", "bills.csv", "customers.csv", "inventory.csv", "invoices.csv", "receipts.csv", "sales_orders.csv", "suppliers.csv"]);
    for (const x of files) { assert.ok(lines(join(a, x)).length - 1 <= 300, x); assert.equal(readFileSync(join(a, x), "utf8"), readFileSync(join(b, x), "utf8"), `${x} differs for the same seed`); }
    const rel = await relationsOf(a);
    for (const want of ["invoices.Invoice No~receipts.Invoice No:key", "invoices.SO No~sales_orders.SO No:key", "bank.Reference~receipts.Receipt No:key", "bank.Reference~bills.Bill No:key", "bills.Supplier ID~suppliers.Supplier ID:key", "inventory.SKU~sales_orders.SKU:key"]) {
      assert.ok(rel.includes(want), `missing ${want}; got ${rel.join(" | ")}`);
    }
  });
  it("smb: the planted story is there (Northline pays late at the end, an open order after the period)", () => {
    const inv = lines(join(root, "smb-a", "invoices.csv")).slice(1).map((l) => l.split(","));
    assert.ok(inv.some((r) => r[2] === "C001" && r[6] === "Overdue"));
    assert.ok(lines(join(root, "smb-a", "sales_orders.csv")).some((l) => l.includes(",C001,") && l.endsWith(",Open")));
  });
  it("smb --ar-ap erpnext: ERPNext REST exports ({\"data\": [...]}) load as tables and relate to the CSV files", async () => {
    const e = join(root, "smb-erp");
    await run(process.execPath, [script("make-finance-fixtures.ts"), "--kind", "smb", "--out", e, "--ar-ap", "erpnext", "--contracts", "off"]);
    const j = JSON.parse(readFileSync(join(e, "erpnext_sales_invoices.json"), "utf8"));
    assert.deepEqual(Object.keys(j.data[0]), ["name", "customer", "customer_name", "posting_date", "due_date", "grand_total", "outstanding_amount", "status", "currency", "po_no"]);
    assert.ok(j.data.every((r: any) => ["Paid", "Unpaid", "Overdue"].includes(r.status)));
    const rel = await relationsOf(e);
    for (const want of ["erpnext_sales_invoices.name~receipts.Invoice No:key", "erpnext_sales_invoices.po_no~sales_orders.SO No:key", "erpnext_purchase_invoices.supplier~suppliers.Supplier ID:key", "bank.Reference~erpnext_purchase_invoices.name:key"]) assert.ok(rel.includes(want), `missing ${want}; got ${rel.join(" | ")}`);
  });
  it("personal: five related files", async () => {
    const p = join(root, "personal");
    await run(process.execPath, [script("make-finance-fixtures.ts"), "--kind", "personal", "--out", p]);
    const rel = await relationsOf(p);
    for (const want of ["bank_statement.Txn ID~bills.Paid Txn ID:key", "bank_statement.Txn ID~card_statements.Paid Txn ID:key", "card_statements.Statement ID~credit_card.Statement ID:key"]) assert.ok(rel.includes(want), `missing ${want}; got ${rel.join(" | ")}`);
  });
  it("refuses bad flags", async () => {
    await assert.rejects(run(process.execPath, [script("make-finance-fixtures.ts"), "--kind", "corp", "--out", join(root, "x")]), /--kind must be smb or personal/);
    await assert.rejects(run(process.execPath, [script("make-finance-fixtures.ts"), "--kind", "smb"]), /--out/);
  });
});

describe("actus-schedule against a stand-in ACTUS server", () => {
  let server: Server, url = "", seen: any = null, answer: any = null;
  before(async () => {
    server = createServer(async (req, res) => { let b = ""; for await (const c of req) b += c; seen = JSON.parse(b); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(answer)); });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(() => server.close());
  // The real ACTUS answer for this ANN (AWS eventsBatch, 2026-10-24), PRF dropped.
  const ann = [{ contractID: "WC-1", status: "Success", message: "", events: [
    { type: "IED", time: "2026-11-02T00:00", payoff: 50000, currency: "USD", nominalValue: -50000, nominalRate: 0.12 },
    { type: "PR", time: "2026-12-02T00:00", payoff: -16501.11, currency: "USD", nominalValue: -33498.89, nominalRate: 0.12 },
    { type: "IP", time: "2026-12-02T00:00", payoff: -500, currency: "USD", nominalValue: -33498.89, nominalRate: 0.12 },
    { type: "PR", time: "2027-01-02T00:00", payoff: -16666.12, currency: "USD", nominalValue: -16832.78, nominalRate: 0.12 },
    { type: "IP", time: "2027-01-02T00:00", payoff: -334.99, currency: "USD", nominalValue: -16832.78, nominalRate: 0.12 },
    { type: "IP", time: "2027-02-02T00:00", payoff: -168.33, currency: "USD", nominalValue: -16832.78, nominalRate: 0.12 },
    { type: "MD", time: "2027-02-02T00:00", payoff: -16832.78, currency: "USD", nominalValue: 0, nominalRate: 0.12 }] }];
  const args = (out: string, extra: string[] = []) => [script("actus-schedule.ts"), "--type", "ANN", "--notional", "50000", "--rate", "0.12", "--start", "2026-11-02", "--months", "3", "--id", "WC-1", "--actus-url", url, "--out", out, ...extra];

  it("sends the ANN contract built from the terms, checks the answer, saves the CSV and a Postman collection", async () => {
    answer = ann;
    const out = join(root, "loan.csv"), pm = join(root, "loan.postman.json");
    const r = await run(process.execPath, args(out, ["--postman-out", pm]));
    const c = seen.contracts[0];
    assert.deepEqual([c.contractType, c.contractRole, c.notionalPrincipal, c.nominalInterestRate, c.initialExchangeDate, c.maturityDate, c.cycleOfPrincipalRedemption, c.dayCountConvention],
      ["ANN", "RPL", 50000, 0.12, "2026-11-02T00:00:00", "2027-02-02T00:00:00", "P1ML0", "30E360"]);
    assert.match(r.stdout, /CHECK {5}pass {2}principal paid back equals the notional/);
    assert.match(r.stdout, /Total paid back 51003\.3\d of which interest 1003\.32/);
    const csv = lines(out);
    assert.equal(csv[0], "Contract ID,Date,Event,Event Name,Payoff,Currency,Principal After,Rate");
    assert.equal(csv.length, 8);
    const pmj = JSON.parse(readFileSync(pm, "utf8"));
    assert.equal(pmj.variable[0].value, url);
    assert.deepEqual(JSON.parse(pmj.item[0].request.body.raw), seen);
  });
  it("saves nothing when a check fails (ACTUS answered 200 with a failure status)", async () => {
    answer = [{ contractID: "WC-1", status: "Failure", message: "bad terms", events: [] }];
    const out = join(root, "bad.csv");
    await assert.rejects(run(process.execPath, args(out)), (e: any) => /FAIL {2}ACTUS status Success/.test(e.stdout) && /Not saved/.test(e.stdout));
    assert.equal(existsSync(out), false);
  });
  it("needs an ACTUS address (no built-in default) and valid terms", async () => {
    await assert.rejects(run(process.execPath, [script("actus-schedule.ts"), "--notional", "1", "--rate", "0.1", "--start", "2026-01-01", "--months", "1"], { env: { ...process.env, ACTUS_URL: "" } }), /--actus-url \(or ACTUS_URL\) is required/);
    await assert.rejects(run(process.execPath, [script("actus-schedule.ts"), "--notional", "1", "--rate", "12", "--start", "2026-01-01", "--months", "1", "--actus-url", url]), /--rate is a decimal/);
  });
});
