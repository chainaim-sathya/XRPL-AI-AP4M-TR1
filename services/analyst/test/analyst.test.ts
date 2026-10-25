/**
 * Tests for the analyst on generated practice-management data with planted problems (scripts/make-fixtures.ts):
 * a card-deposit leak from 2026-06, a payer that stops paying from 2026-07, and duplicated payment rows.
 *
 *   npm test        (runs every *.test.ts file in this folder)
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type Analysis, analyze, judge } from "../src/analyze.ts";
import { type DataConfig, type Settings, HttpError, insideRoots } from "../src/config.ts";
import { openDb, rows, amountExpr, dateExpr } from "../src/db.ts";
import { type FileProfile, type Recipe, profileFolder, proposeRecipe, validateRecipe } from "../src/profile.ts";
import { evidenceOf, findingsOf, verifyAnswer } from "../src/report.ts";

const settings: Settings = { period: "month", baselinePeriods: 3, variancePct: 2, varianceAmount: 100, dateWindowDays: 3, amountTolerance: 0.01, match: "auto", pairMode: "auto", agingDays: 30 };
const root = mkdtempSync(join(tmpdir(), "analyst-test-"));
const folder = join(root, "pm", "clinic-a");
const cfg: DataConfig = { allowedRoots: [root], exclude: [/^~\$.*$/i, /^.*draft.*$/i], hideFolders: [/^_.*$/], workDir: join(root, "_analyst") };
let profiles: FileProfile[], recipe: Recipe, an: Analysis;

before(async () => {
  execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/make-fixtures.ts", import.meta.url)), "--out", folder, "--production-rows", "8000", "--months", "9"], { stdio: "ignore" });
  profiles = await profileFolder(folder, cfg, 20, 500_000_000, openDb);
  recipe = validateRecipe(proposeRecipe(folder, profiles), profiles);
  const db = await openDb();
  try { an = await analyze(db, recipe, profiles, settings, { topRows: 5 }); } finally { db.close(); }
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("profile and proposal", () => {
  it("types columns and proposes roles, kinds and the money flow", () => {
    const col = (f: string, c: string) => profiles.find((p) => p.name === f)!.columns.find((x) => x.name === c)!.type;
    assert.equal(col("collections.csv", "Posted Date"), "date"); // US dates
    assert.equal(col("bank.csv", "Date"), "date"); // ISO dates
    assert.equal(col("production.csv", "Claim #"), "text"); // "CLM-100000" is not a number
    assert.equal(col("production.csv", "Charge"), "number");
    assert.deepEqual(recipe.flow, ["production.csv", "collections.csv", "bank.csv"]);
    assert.equal(recipe.files["bank.csv"].kind, "deposits");
    assert.equal(recipe.files["bank.csv"].measure, "inflows");
    assert.equal(recipe.files["collections.csv"].roles.party, "Payer");
    assert.equal(recipe.files["production.csv"].roles.reference, "Claim #");
  });
  it("rejects a recipe naming a column that does not exist", () => {
    const bad = structuredClone(recipe);
    bad.files["bank.csv"].roles.amount = "Nope";
    assert.throws(() => validateRecipe(bad, profiles), /does not exist/);
  });
});

describe("analysis finds the planted problems", () => {
  it("collections → deposits goes off in 2026-06 and stays off (card batches not deposited)", () => {
    const p = an.pairs.find((x) => x.label === "collections.csv → bank.csv")!;
    assert.equal(p.mode, "tie");
    assert.equal(p.run?.start, "2026-06-01");
    assert.equal(p.run?.ongoing, true);
    assert.ok(p.run!.cumulativeGap < -50_000);
    for (const t of p.tie.filter((t) => t.period >= "2026-02-01" && t.period < "2026-06-01")) assert.notEqual(t.status, "off", t.period);
  });
  it("production → collections is judged as a ratio and matched by claim number", () => {
    const p = an.pairs.find((x) => x.label === "production.csv → collections.csv")!;
    assert.equal(p.mode, "ratio");
    assert.equal(p.match?.by, "reference");
    assert.equal(p.tie[0].status, "n/a"); // warm-up
  });
  it("the payer that stopped paying stands out in unpaid claims", () => {
    const u = an.pairs.find((x) => x.label === "production.csv → collections.csv")!.match!.unmatchedA;
    const top = u.byParty[0];
    assert.equal(top.party, "Northwind Dental Plan");
    assert.ok(top.share / top.normalShare >= 1.5, `share ${top.share} vs normal ${top.normalShare}`);
  });
  it("collected-but-not-deposited rows are found, mostly card (self-pay) payments", () => {
    const u = an.pairs.find((x) => x.label === "collections.csv → bank.csv")!.match!.unmatchedA;
    assert.ok(u.count > 100);
    assert.equal(u.byParty[0].party, "Self-pay");
  });
  it("finds the planted duplicate payments", () => {
    assert.ok(an.files.find((f) => f.name === "collections.csv")!.duplicates.extraRows >= 2);
  });
  it("ranks findings by money impact", () => {
    const fs = findingsOf(an, 12);
    for (let i = 1; i < fs.length; i++) assert.ok(fs[i - 1].impact >= fs[i].impact);
  });
});

describe("evidence pack", () => {
  const fs = () => findingsOf(an, 12);
  it("fits every budget it accepts, and narrows instead of truncating", () => {
    for (const budget of [16000, 8000, 6000, 4000, 2500, 1500]) {
      const ev = evidenceOf(an, fs(), budget, 3);
      assert.ok(ev.chars <= budget, `${ev.chars} > ${budget}`);
      assert.ok(ev.text.startsWith("DATA ANALYSIS"));
    }
  });
  it("keeps findings before old periods", () => {
    const ev = evidenceOf(an, fs(), 6000, 3);
    assert.equal(ev.findingsShown, ev.findingsTotal);
    assert.ok(ev.periodsShown < ev.periodsTotal);
  });
  it("refuses a budget too small for even the file list", () => {
    assert.throws(() => evidenceOf(an, fs(), 300, 3), /exceed the evidence budget/);
  });
  it("never contains more example rows than allowed", () => {
    const ev = evidenceOf(an, fs(), 16000, 2);
    for (const block of ev.text.split(/\n(?=\d+\. )/)) assert.ok((block.match(/^ {2}row \d+ of /gm) ?? []).length <= 2);
  });
});

describe("number check", () => {
  it("lists numbers that are not in the evidence", () => {
    const ev = "variance -90,422.30 since June; 619 rows; 161,809.05";
    const r = verifyAnswer("The gap is -90,422.30 over 619 rows, about 99,999.99 in total, in 2026.", ev);
    assert.deepEqual(r.notFound, ["99,999.99"]);
    assert.equal(r.checked, 3);
  });
});

describe("judging pairs", () => {
  it("tie mode: off needs the band AND the amount; watch needs half the band AND the amount", () => {
    const t = judge([
      { period: "2026-01-01", a: 1000, b: 950 },     // 5% but only 50: under the amount -> ok
      { period: "2026-02-01", a: 100000, b: 97000 }, // 3% and 3,000 -> off
      { period: "2026-03-01", a: 100000, b: 98500 }, // 1.5% (over half of 2%) and 1,500 -> watch
      { period: "2026-04-01", a: 100000, b: 99500 }, // 0.5% -> ok
    ], "tie", settings);
    assert.deepEqual(t.map((x) => x.status), ["ok", "off", "watch", "ok"]);
  });
});

describe("parsing", () => {
  it("reads currency, separators, parentheses and dates", async () => {
    const db = await openDb();
    try {
      await db.conn.run(`CREATE TABLE t AS SELECT * FROM (VALUES ('$1,240.50','01/31/2026'), ('(500.00)','2026-02-28'), ('300-','31/03/2026'), ('CLM-100','x'), ('₹ 12,000','2026/04/01')) v(a, d)`);
      const r = await rows<{ v: number | null; d: string | null }>(db, `SELECT ${amountExpr("a")} v, CAST(${dateExpr("d", null)} AS VARCHAR) d FROM t`);
      assert.deepEqual(r.map((x) => x.v), [1240.5, -500, -300, null, 12000]);
      assert.deepEqual(r.map((x) => x.d), ["2026-01-31", "2026-02-28", "2026-03-31", null, "2026-04-01"]);
    } finally { db.close(); }
  });
});

describe("confinement", () => {
  it("refuses paths outside the allowed roots, relative paths, the work dir and links that lead out", async () => {
    const outside = mkdtempSync(join(tmpdir(), "analyst-outside-"));
    writeFileSync(join(outside, "secret.csv"), "a,b\n1,2\n");
    mkdirSync(join(root, "links"), { recursive: true });
    symlinkSync(outside, join(root, "links", "escape"), process.platform === "win32" ? "junction" : "dir"); // a junction needs no admin rights on Windows
    mkdirSync(cfg.workDir, { recursive: true });
    const status = async (p: string) => { try { await insideRoots(p, cfg); return 200; } catch (e) { return (e as HttpError).status; } };
    assert.equal(await status(folder), 200);
    assert.equal(await status(outside), 403);
    assert.equal(await status(join(folder, "..", "..", "..", "..")), 403);
    assert.equal(await status("relative/path"), 400);
    assert.equal(await status(cfg.workDir), 403);
    assert.equal(await status(join(root, "links", "escape")), 403);
    rmSync(outside, { recursive: true, force: true });
  });
});
