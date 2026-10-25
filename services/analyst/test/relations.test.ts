/**
 * Cross-file questions: relations between the files of one folder (relate.ts), the read-only query runner (sqlrun.ts),
 * the question flow with a stand-in model (crossask.ts) and the /relations and /sql routes (main.ts).
 * Synthetic data only: make-fixtures.ts, plus a small hand-written patients/visits folder.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type DataConfig } from "../src/config.ts";
import { type Msg, crossAsk, extractSql, fanOutJoins, resultText } from "../src/crossask.ts";
import { type Db, lockFiles, openDb } from "../src/db.ts";
import { profileFolder } from "../src/profile.ts";
import { type Relation, type TableSchema, loadAndRelate, nameScore, schemaText, tableNames } from "../src/relate.ts";
import { SqlRefused, checkSelect, runSelect } from "../src/sqlrun.ts";

const root = mkdtempSync(join(tmpdir(), "analyst-rel-"));
const pm = join(root, "pm"), clinic = join(root, "clinic");
const cfg: DataConfig = { allowedRoots: [root], exclude: [], hideFolders: [/^_.*$/], workDir: join(root, "_analyst") };

async function related(folder: string): Promise<{ db: Db; tables: TableSchema[]; relations: Relation[] }> {
  const profs = await profileFolder(folder, cfg, 20, 500_000_000, openDb);
  const db = await openDb();
  const r = await loadAndRelate(db, profs);
  await lockFiles(db);
  return { db, ...r };
}
const find = (rs: Relation[], ta: string, ca: string, tb: string, cb: string) =>
  rs.find((r) => (r.a.table === ta && r.a.column === ca && r.b.table === tb && r.b.column === cb) || (r.a.table === tb && r.a.column === cb && r.b.table === ta && r.b.column === ca));

let PM: Awaited<ReturnType<typeof related>>, CL: Awaited<ReturnType<typeof related>>;
before(async () => {
  execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/make-fixtures.ts", import.meta.url)), "--out", pm, "--production-rows", "600", "--months", "4"], { stdio: "ignore" });
  mkdirSync(clinic, { recursive: true });
  // Different header names for the same id (Patient ID / pt_id), and a plan code shared as a category.
  const patients = ["Patient ID,Full Name,Plan"], visits = ["Visit No,pt_id,Visit Date,Fee,Plan Code"];
  const plans = ["GOLD", "SILVER", "BRONZE", "BASIC"];
  for (let i = 1; i <= 40; i++) patients.push(`${1000 + i},Person ${i},${plans[i % 4]}`);
  for (let v = 1; v <= 120; v++) { const p = 1000 + ((v * 7) % 40) + 1; visits.push(`V${v},${p},2026-0${1 + (v % 6)}-1${v % 9},${(50 + (v % 5) * 25).toFixed(2)},${plans[(p - 1000) % 4].toLowerCase()} `); }
  writeFileSync(join(clinic, "patients.csv"), patients.join("\n") + "\n");
  writeFileSync(join(clinic, "visits.csv"), visits.join("\n") + "\n");
  writeFileSync(join(clinic, "rates.csv"), "Currency,Rate\nUSD,1\nEUR,0.9\nGBP,0.8\n");
  PM = await related(pm);
  CL = await related(clinic);
});
after(() => { PM?.db.close(); CL?.db.close(); rmSync(root, { recursive: true, force: true }); });

describe("relations between files", () => {
  it("names tables after the files, safely", () => {
    assert.deepEqual([...tableNames(["bank.csv", "Q1 sales (final).csv", "2026.csv", "bank.tsv"]).values()], ["bank", "q1_sales_final", "t_2026", "bank_2"]);
  });
  it("scores header names: same name, synonyms, unrelated", () => {
    assert.equal(nameScore("Claim #", "claim #"), 1);
    assert.equal(nameScore("Claim #", "Claim No"), 1);
    assert.equal(nameScore("Patient ID", "pt_id"), 1);
    assert.equal(nameScore("Charge", "Payer"), 0);
  });
  it("finds the claim key between production and collections from the values", () => {
    const r = find(PM.relations, "production", "Claim #", "collections", "Claim #");
    assert.ok(r, "Claim # relation");
    assert.equal(r.link, "key");
    assert.ok(r.overlap >= 0.95, `overlap ${r.overlap}`);
    assert.ok(["one-to-many", "many-to-one", "one-to-one"].includes(r.cardinality));
  });
  it("relates headers with different names (Patient ID ~ pt_id) and marks a shared code list as a category", () => {
    const id = find(CL.relations, "patients", "Patient ID", "visits", "pt_id");
    assert.ok(id, "Patient ID ~ pt_id");
    assert.equal(id.link, "key");
    assert.equal(id.overlap, 1);
    const side = id.a.table === "patients" ? id.a : id.b;
    assert.equal(side.unique, true);
    const plan = find(CL.relations, "patients", "Plan", "visits", "Plan Code"); // values differ in case and trailing space
    assert.ok(plan, "Plan ~ Plan Code");
    assert.equal(plan.link, "category");
  });
  it("judges uniqueness on the whole file, not the profile's 2,000-row sample (owner run 2026-10-24: 8,000 claims showed many-to-many)", async () => {
    const big = join(root, "big");
    mkdirSync(big, { recursive: true });
    const ids = ["Invoice No,Customer"], pays = ["Invoice,Paid"];
    for (let i = 1; i <= 2600; i++) { ids.push(`INV-${100000 + i},C${i % 40}`); if (i % 2) { pays.push(`INV-${100000 + i},1.00`); pays.push(`INV-${100000 + i},2.00`); } }
    writeFileSync(join(big, "invoices.csv"), ids.join("\n") + "\n");
    writeFileSync(join(big, "payments.csv"), pays.join("\n") + "\n");
    const B = await related(big);
    try {
      const r = find(B.relations, "invoices", "Invoice No", "payments", "Invoice");
      assert.ok(r, "Invoice No ~ Invoice");
      const inv = r.a.table === "invoices" ? r.a : r.b, pay = r.a.table === "invoices" ? r.b : r.a;
      assert.equal(inv.unique, true);
      assert.equal(pay.unique, false);
      assert.equal(r.cardinality, r.a.table === "invoices" ? "one-to-many" : "many-to-one");
    } finally { B.db.close(); }
  });
  it("never relates money, dates or unrelated files", () => {
    for (const r of [...PM.relations, ...CL.relations]) {
      for (const s of [r.a, r.b]) assert.doesNotMatch(s.column, /charge|paid amount|amount|fee|date|rate/i, `${s.table}.${s.column}`);
      assert.ok(r.a.table !== "rates" && r.b.table !== "rates");
    }
  });
  it("lists the values of code columns (status, type ...) only, so a model can filter on them; names and ids never", async () => {
    const big = join(root, "codes");
    mkdirSync(big, { recursive: true });
    writeFileSync(join(big, "inv.csv"), "Invoice No,Customer Name,Status,Amount\n" + Array.from({ length: 30 }, (_, i) => `I${i},Person ${i},${["Paid", "Overdue", "Unpaid"][i % 3]},${i}.50`).join("\n") + "\n");
    writeFileSync(join(big, "pay.csv"), "Invoice No,Method\n" + Array.from({ length: 20 }, (_, i) => `I${i},${["Wire", "ACH"][i % 2]}`).join("\n") + "\n");
    const B = await related(big);
    try {
      const text = schemaText(B.tables, B.relations);
      assert.match(text, /"Status" VARCHAR \(values: 'Overdue', 'Paid', 'Unpaid'\)/);
      assert.match(text, /"Method" VARCHAR \(values: 'ACH', 'Wire'\)/);
      assert.doesNotMatch(text, /Person \d|I\d+/);
    } finally { B.db.close(); }
  });
  it("the schema text holds headers and relations but no data values", () => {
    const text = schemaText(PM.tables, PM.relations);
    assert.match(text, /production\s+\(file production\.csv, 600 rows\)/);
    assert.match(text, /"Claim #" VARCHAR/);
    assert.match(text, /"Charge" DOUBLE/);
    const prod = readFileSync(join(pm, "production.csv"), "utf8").split("\n")[1].split(",");
    for (const v of prod) assert.ok(!text.includes(v.trim()), `value ${v} leaked into the schema`);
  });
});

describe("read-only queries", () => {
  it("joins two files and gets the exact answer", async () => {
    const r = await runSelect(CL.db, `SELECT p."Plan", count(*) visits, round(sum(v."Fee"), 2) fees FROM visits v JOIN patients p ON upper(trim(CAST(v."pt_id" AS VARCHAR))) = upper(trim(CAST(p."Patient ID" AS VARCHAR))) GROUP BY 1 ORDER BY 1`, { maxRows: 50, timeoutMs: 5000 });
    // The same numbers straight from the CSV text.
    const plan = new Map(readFileSync(join(clinic, "patients.csv"), "utf8").trim().split("\n").slice(1).map((l) => l.split(",")).map(([id, , pl]) => [id, pl]));
    const want = new Map<string, { n: number; fee: number }>();
    for (const l of readFileSync(join(clinic, "visits.csv"), "utf8").trim().split("\n").slice(1)) { const [, pt, , fee] = l.split(","); const k = plan.get(pt)!; const e = want.get(k) ?? { n: 0, fee: 0 }; e.n++; e.fee += Number(fee); want.set(k, e); }
    assert.equal(r.rows.length, want.size);
    for (const row of r.rows) { const w = want.get(String(row.Plan))!; assert.equal(Number(row.visits), w.n); assert.equal(Number(row.fees), Math.round(w.fee * 100) / 100); }
  });
  it("refuses anything but one SELECT", () => {
    for (const q of ["DROP TABLE visits", "SELECT 1; SELECT 2", "SELECT * FROM read_csv('/etc/passwd')", "SELECT 1 -- hi", "COPY visits TO 'x.csv'", "ATTACH 'x.db'", "WITH a AS (SELECT 1) INSERT INTO visits SELECT * FROM a", "SELECT getenv('HOME')", "PRAGMA version", ""]) {
      assert.throws(() => checkSelect(q), SqlRefused, q);
    }
    assert.equal(checkSelect(`SELECT "Plan" FROM patients WHERE "Plan" = 'drop; copy'; `), `SELECT "Plan" FROM patients WHERE "Plan" = 'drop; copy'`);
    assert.equal(checkSelect(`SELECT "Update Date", "Set" FROM t OFFSET 1`).startsWith("SELECT"), true);
  });
  it("cannot read a file even when a query gets past the check (file access is locked)", async () => {
    await assert.rejects(runSelect(CL.db, `SELECT * FROM '${join(clinic, "patients.csv").replace(/'/g, "''")}'`, { maxRows: 5, timeoutMs: 5000 }), SqlRefused);
  });
  it("rounds floating-point tails to 6 decimals (412345.6700000001 -> 412345.67)", async () => {
    const r = await runSelect(CL.db, "SELECT 0.1::DOUBLE + 0.2::DOUBLE AS a, 412345.67::DOUBLE + 0.0000000001::DOUBLE AS b, 5 AS c", { maxRows: 5, timeoutMs: 5000 });
    assert.deepEqual(r.rows[0], { a: 0.3, b: 412345.67, c: 5 });
  });
  it("limits the rows and stops a slow query", async () => {
    const r = await runSelect(PM.db, "SELECT * FROM production", { maxRows: 7, timeoutMs: 5000 });
    assert.equal(r.rows.length, 7);
    assert.equal(r.truncated, true);
    await assert.rejects(runSelect(PM.db, "SELECT count(*) FROM range(3000000000) a, range(10) b", { maxRows: 5, timeoutMs: 200 }), /took over 200 ms/);
  });
});

describe("a question across files, with a stand-in model", () => {
  const analystOf = (x: typeof CL) => async (route: "relations" | "sql", body: Record<string, unknown>) => {
    if (route === "relations") return { relations: x.relations, schema: schemaText(x.tables, x.relations) };
    try { return await runSelect(x.db, body.sql, { maxRows: 200, timeoutMs: 5000 }); } catch (e) { throw new Error((e as Error).message); }
  };
  const good = 'SELECT p."Plan", count(*) AS visits FROM visits v JOIN patients p ON v."pt_id" = p."Patient ID" GROUP BY 1 ORDER BY 1';

  it("the model writes the query from headers only, the analyst runs it, the answer is checked", async () => {
    const seen: Msg[][] = [];
    const replies = ["```sql\nSELECT nope FROM visits\n```", "Here you go:\n```sql\n" + good + ";\n```", "BASIC has 30 visits and GOLD has 999."];
    const res = await crossAsk({ folder: clinic, question: "How many visits per plan?", model: "chainaim/auto", phrase: "llm", sqlRetries: 1, answerMaxRows: 50 },
      { analyst: analystOf(CL), chat: async (m) => { seen.push(structuredClone(m)); return { text: replies[seen.length - 1], model: "stub/m", zone: "local" }; } });
    assert.equal(res.error, undefined);
    assert.equal(res.attempts.length, 2);
    assert.match(res.attempts[0].error!, /failed/);
    assert.equal(res.sql, good);
    assert.equal(res.result!.rows.length, 4);
    // Query steps carried headers only: no person names, ids or fees from the files.
    for (const m of seen.slice(0, 2).flat()) assert.doesNotMatch(m.content, /Person \d|10\d\d,|V\d+,/);
    assert.deepEqual(res.sentToModel.map((s) => [s.step, s.hasData]), [["query", false], ["query (retry)", false], ["answer", true]]);
    assert.ok(seen[2][1].content.includes("BASIC | 30"), "the answer step gets the result table");
    assert.deepEqual(res.unverified, ["999"]); // a number that is not in the result
  });
  it("an answer with a placeholder left in it is not reported as checked (owner run: \"$<PHONE>.07\")", async () => {
    const res = await crossAsk({ folder: clinic, question: "q", model: "x/y", phrase: "llm", sqlRetries: 0, answerMaxRows: 5, sql: good },
      { analyst: analystOf(CL), chat: async () => ({ text: "BASIC has 30 visits for $<PHONE>.07 and <PERSON_2>." }) });
    assert.deepEqual(res.unverified, ["<PHONE>", "<PERSON_2>"]);
  });
  it("no rows: the model gets one more look; an empty last result is answered without a model (owner run 2026-10-24)", async () => {
    const empty = 'SELECT "Plan", count(*) n FROM patients WHERE "Plan" = \'PLATINUM\' GROUP BY 1';
    const seen: Msg[][] = [];
    const replies = ["```sql\n" + empty + "\n```", "```sql\n" + good + "\n```"];
    const res = await crossAsk({ folder: clinic, question: "visits per plan", model: "x/y", phrase: "llm", sqlRetries: 1, answerMaxRows: 50 },
      { analyst: analystOf(CL), chat: async (m) => { seen.push(structuredClone(m)); return { text: replies[seen.length - 1] ?? "BASIC has 30 visits." }; } });
    assert.equal(res.attempts[0].error, "the query ran but returned no rows");
    assert.match(seen[1].at(-1)!.content, /returned no rows/);
    assert.equal(res.result!.rows.length, 4);
    const res2 = await crossAsk({ folder: clinic, question: "q", model: "x/y", phrase: "llm", sqlRetries: 0, answerMaxRows: 50 },
      { analyst: analystOf(CL), chat: async () => ({ text: "```sql\n" + empty + "\n```" }) });
    assert.equal(res2.result!.rows.length, 0);
    assert.match(res2.answer!, /returned no rows/);
    assert.equal(res2.sentToModel.some((s) => s.hasData), false, "an empty result is never sent to be worded");
  });
  it("a join on a many-to-many relation is caught: one more try, and a warning if it stays (owner run 2026-10-24: totals x117)", async () => {
    const fan = 'SELECT p."Plan", count(*) visits FROM visits v JOIN patients p ON upper(trim(v."Plan Code")) = upper(trim(p."Plan")) GROUP BY 1';
    const rels = CL.relations;
    assert.ok(fanOutJoins(fan, rels).length === 1, `expected a fan-out warning; relations: ${JSON.stringify(rels.map((r) => [r.a.table, r.a.column, r.b.table, r.b.column, r.link]))}`);
    assert.deepEqual(fanOutJoins(good, rels), [], "a join on the key is fine");
    const replies = ["```sql\n" + fan + "\n```", "```sql\n" + good + "\n```"];
    let n = 0;
    const res = await crossAsk({ folder: clinic, question: "visits per plan", model: "x/y", phrase: "none", sqlRetries: 1, answerMaxRows: 50 }, { analyst: analystOf(CL), chat: async () => ({ text: replies[n++] }) });
    assert.match(res.attempts[0].error!, /many-to-many/);
    assert.equal(res.sql, good);
    assert.deepEqual(res.warnings, []);
    const stuck = await crossAsk({ folder: clinic, question: "q", model: "x/y", phrase: "none", sqlRetries: 0, answerMaxRows: 50 }, { analyst: analystOf(CL), chat: async () => ({ text: "```sql\n" + fan + "\n```" }) });
    assert.equal(stuck.warnings.length, 1);
    assert.match(stuck.warnings[0], /counts and sums are multiplied/);
  });
  it("--answer-model: the query by one model, the worded answer by another", async () => {
    const used: string[] = [];
    const res = await crossAsk({ folder: clinic, question: "q", model: "hosted/x", answerModel: "local/y", phrase: "llm", sqlRetries: 0, answerMaxRows: 5 },
      { analyst: analystOf(CL), chat: async (_m, model) => { used.push(model); return { text: used.length === 1 ? "```sql\n" + good + "\n```" : "ok" }; } });
    assert.deepEqual(used, ["hosted/x", "local/y"]);
    assert.equal(res.answer, "ok");
  });
  it("keeps the computed result when only the worded answer fails", async () => {
    let n = 0;
    const res = await crossAsk({ folder: clinic, question: "q", model: "x/y", phrase: "llm", sqlRetries: 0, answerMaxRows: 5, sql: good },
      { analyst: analystOf(CL), chat: async () => { n++; throw new Error("gateway: every model tried failed"); } });
    assert.equal(n, 1);
    assert.equal(res.result!.rows.length, 4);
    assert.match(res.error!, /result is below, but the worded answer failed: gateway: every model tried failed/);
  });
  it("with the person's own query and phrase none, no model is called at all", async () => {
    let calls = 0;
    const res = await crossAsk({ folder: clinic, question: "visits per plan", model: "x/y", phrase: "none", sqlRetries: 2, answerMaxRows: 50, sql: good }, { analyst: analystOf(CL), chat: async () => { calls++; return { text: "" }; } });
    assert.equal(calls, 0);
    assert.equal(res.result!.rows.length, 4);
    assert.equal(res.answer, null);
    assert.deepEqual(res.sentToModel, []);
  });
  it("gives up after the retries and says why", async () => {
    const res = await crossAsk({ folder: clinic, question: "q", model: "x/y", phrase: "llm", sqlRetries: 1, answerMaxRows: 5 }, { analyst: analystOf(CL), chat: async () => ({ text: "DROP TABLE visits" }) });
    assert.equal(res.result, null);
    assert.equal(res.attempts.length, 2); // the first try and one retry
    assert.match(res.error!, /did not reply with a query/);
  });
  it("extracts the query and prints a result table", () => {
    assert.equal(extractSql("```sql\nselect 1;\n```"), "select 1");
    assert.equal(extractSql("Sure. WITH a AS (SELECT 1) SELECT * FROM a"), "WITH a AS (SELECT 1) SELECT * FROM a");
    assert.equal(extractSql("I cannot"), null);
    assert.equal(resultText({ columns: ["a", "b"], rows: [{ a: 1, b: "x|y" }, { a: 2, b: null }], truncated: false }, 1), "a | b\n1 | x y\n(only the first 1 rows are shown)");
  });
});

describe("routes /relations and /sql", () => {
  let child: ChildProcess, port = 0;
  before(async () => {
    port = await new Promise<number>((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });
    const dc = join(root, "data-sources.json");
    writeFileSync(dc, JSON.stringify({ allowedRoots: [root] }));
    child = spawn(process.execPath, [fileURLToPath(new URL("../src/main.ts", import.meta.url)), "--port", String(port), "--data-config", dc, "--sql-max-rows", "3"], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((ok, no) => { child.stdout!.on("data", (d) => { if (String(d).includes("[analyst]")) ok(); }); child.on("exit", (c) => no(new Error(`analyst exited ${c}`))); });
  });
  after(() => child?.kill());
  const post = async (route: string, body: unknown) => { const r = await fetch(`http://127.0.0.1:${port}/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as any }; };

  it("/relations needs no recipe and returns tables, relations and the schema text", async () => {
    const r = await post("relations", { folder: clinic });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.tables.map((t: TableSchema) => t.table).sort(), ["patients", "rates", "visits"]);
    assert.ok(find(r.body.relations, "patients", "Patient ID", "visits", "pt_id"));
    assert.match(r.body.schema, /Relations found/);
  });
  it("/sql runs a SELECT with the row limit and refuses anything else with 400", async () => {
    const ok = await post("sql", { folder: clinic, sql: "SELECT * FROM visits" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.rows.length, 3);
    assert.equal(ok.body.truncated, true);
    const bad = await post("sql", { folder: clinic, sql: "DROP TABLE visits" });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /must start with SELECT/);
    const out = await post("relations", { folder: "/" });
    assert.equal(out.status, 403);
  });
});
