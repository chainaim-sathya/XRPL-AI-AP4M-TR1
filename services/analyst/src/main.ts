/**
 * chainaim-analyst: exact cross-file analysis of a folder of CSV/TSV files, for the test console's
 * "03 Private chat + analysis" tab. Compute only: it never calls a model, holds no keys and listens on 127.0.0.1.
 *
 *   node src/main.ts [flags]
 *
 *   --port N                     default 8740
 *   --data-config PATH           allowed data folders, shared with the console (default ../../config/data-sources.json)
 *   --work-dir PATH              recipes and run manifests, no data (default <first allowedRoot>/_analyst)
 *   --period week|month|quarter  default month
 *   --baseline-periods N         periods before a variance run shown as its baseline (default 3)
 *   --variance-pct P             a period is "off" when |variance| is over P% ... (default 2)
 *   --variance-amount A          ... and over A (default 100)
 *   --date-window-days D         matching: dates within D days (default 3)
 *   --amount-tolerance T         matching: amounts within T (default 0.01)
 *   --match auto|one-to-one|many-to-one|none   default auto (both; matching counts only when at least 20% (by
 *                                reference) or 50% (by amount) of a file's rows match)
 *   --pair-mode auto|tie|ratio   tie: later stage should equal earlier; ratio: should keep a stable share;
 *                                auto: tie when the median |ratio - 1| is at most 10% (default auto)
 *   --aging-days N               unmatched rows older than N days at the last date of the later file (default 30)
 *   --evidence-max-chars N       hard ceiling for an evidence pack (default 16000)
 *   --evidence-rows-per-finding N  example rows per finding (default 3)
 *   --max-findings N             default 12
 *   --max-bytes N                largest file analyzed (default 500000000)
 *   --max-files N                most data files in one folder (default 20)
 *   --keep-findings              also write findings.json next to each manifest (holds real amounts and names)
 *   --runs-in-memory N           analyses kept for evidence/verify calls (default 10)
 *   --relation-min-overlap X     cross-file relations: least share of the smaller column's distinct values found in the
 *                                other column (default 0.5)
 *   --relation-min-shared N      ... and at least N shared distinct values (default 3)
 *   --relation-max-distinct N    distinct values compared per column at most (default 50000)
 *   --relation-max N             most relations returned, best first (default 40)
 *   --schema-code-values N       code columns (status, type, method, category, currency, ...) with at most N distinct
 *                                values list them in the schema text a model gets (default 12; 0 = never)
 *   --sql-max-rows N             most rows a /sql query returns (default 200; truncated is then true)
 *   --sql-timeout-ms N           a /sql query is stopped after this long (default 15000)
 *
 * A folder's recipe may override period, baselinePeriods, variancePct, varianceAmount, dateWindowDays,
 * amountTolerance, match, pairMode, agingDays and expectedRatio (pins the ratio for ratio pairs) in "settings".
 *
 * Routes (JSON; Host must be 127.0.0.1:<port> or localhost:<port>):
 *   GET  /healthz
 *   POST /profile  {folder}            files, columns, proposed recipe, saved recipe
 *   POST /recipe   {folder, recipe}    validate and save the confirmed recipe
 *   POST /analyze  {folder}            run every check with the saved recipe
 *   POST /status   {folder}            have the files changed since the last analysis?
 *   POST /evidence {runId, budget?}    the evidence pack, within min(budget, --evidence-max-chars)
 *   POST /verify   {runId, answer, evidence}  numbers in the answer not found in the evidence
 *   POST /relations {folder}           every file as a typed table, and how the files relate (column, overlap,
 *                                      cardinality), plus "schema", the text a model gets: headers only, no values.
 *                                      Needs no recipe.
 *   POST /sql {folder, sql}            one read-only SELECT on those tables (checked, file access locked, row limit,
 *                                      timeout): {columns, rows, truncated, ms}. 400 with the reason when refused.
 *
 * Tests: npm test (generates synthetic data with planted problems; no real data needed).
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { type Analysis, analyze } from "./analyze.ts";
import { type DataConfig, type Flags, HttpError, insideRoots, isFolder, parseFlags, readDataConfig, settingsOf } from "./config.ts";
import { type Db, lockFiles, openDb } from "./db.ts";
import { type Relation, type TableSchema, loadAndRelate, schemaText } from "./relate.ts";
import { SqlRefused, runSelect } from "./sqlrun.ts";
import { type FileProfile, folderId, listDataFiles, profileFolder, proposeRecipe, readRecipe, saveRecipe, sha256File, validateRecipe, writeJson } from "./profile.ts";
import { type Finding, evidenceOf, findingsOf, scorecardOf, verifyAnswer } from "./report.ts";

const VERSION = "1.0.0";
const flags: Flags = parseFlags(process.argv.slice(2));
type Stored = { runId: string; folder: string; analysis: Analysis; findings: Finding[] };
const runs = new Map<string, Stored>();

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage): Promise<Record<string, any>> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "send application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > 4_000_000) throw new HttpError(413, "request body over 4 MB"); chunks.push(c as Buffer); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw new HttpError(400, "body must be JSON"); }
}
const hostOk = (req: IncomingMessage): boolean => { const h = (req.headers.host ?? "").toLowerCase(); return h === `127.0.0.1:${flags.port}` || h === `localhost:${flags.port}`; };

async function folderOf(b: Record<string, any>, cfg: DataConfig): Promise<string> {
  const folder = await insideRoots(b.folder, cfg);
  if (!(await isFolder(folder))) throw new HttpError(400, "not a folder");
  return folder;
}
const profiles = (folder: string, cfg: DataConfig): Promise<FileProfile[]> => profileFolder(folder, cfg, flags.maxFiles, flags.maxBytes, openDb);

async function runAnalysis(folder: string, cfg: DataConfig) {
  const recipe = await readRecipe(cfg.workDir, folder);
  if (!recipe) throw new HttpError(409, "no confirmed recipe for this folder yet: POST /profile, review the proposal, then POST /recipe");
  const profs = await profiles(folder, cfg);
  const recipeChecked = validateRecipe(recipe, profs); // the folder may have changed since the recipe was saved
  const tooBig = profs.filter((p) => p.tooBig && recipeChecked.files[p.name]?.include);
  if (tooBig.length) throw new HttpError(413, `over --max-bytes: ${tooBig.map((p) => p.name).join(", ")}`);
  const settings = { ...settingsOf(flags), ...(recipe.settings ?? {}) };
  const started = Date.now();
  const db = await openDb();
  let analysis: Analysis;
  try { analysis = await analyze(db, recipeChecked, profs, settings, { topRows: Math.max(5, flags.evidenceRowsPerFinding) }); }
  finally { db.close(); }
  const findings = findingsOf(analysis, flags.maxFindings);
  const runId = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
  const files = [];
  for (const p of profs) if (recipeChecked.files[p.name]?.include) files.push({ name: p.name, bytes: p.bytes, modified: p.modified, rows: p.rows, sha256: await sha256File(p.path) });
  const manifest = { runId, folderId: folderId(folder), ranAt: new Date().toISOString(), ms: Date.now() - started, analystVersion: VERSION, files, flow: recipeChecked.flow, settings,
    counts: { rows: analysis.files.reduce((n, f) => n + f.rows, 0), pairs: analysis.pairs.length, findings: findings.length } };
  const dir = join(cfg.workDir, "runs", folderId(folder));
  await writeJson(join(dir, runId, "manifest.json"), manifest);
  await writeJson(join(dir, "latest.json"), manifest);
  if (flags.keepFindings) await writeJson(join(dir, runId, "findings.json"), { findings, scorecard: scorecardOf(analysis) });
  runs.set(runId, { runId, folder, analysis, findings });
  while (runs.size > flags.runsInMemory) runs.delete(runs.keys().next().value as string);
  return { runId, folder, manifest, scorecard: scorecardOf(analysis), findings, files: analysis.files, pairs: analysis.pairs, periodUnit: analysis.periodUnit };
}

async function status(folder: string, cfg: DataConfig) {
  let last: { runId: string; ranAt: string; files: { name: string; bytes: number; modified: string }[] } | null = null;
  try { last = JSON.parse(await readFile(join(cfg.workDir, "runs", folderId(folder), "latest.json"), "utf8")); } catch { /* never analyzed */ }
  const recipe = await readRecipe(cfg.workDir, folder);
  if (!last) return { analyzed: false, recipe: Boolean(recipe), changed: true, differences: ["never analyzed"] };
  const now = await listDataFiles(folder, cfg, flags.maxFiles);
  const included = recipe ? Object.entries(recipe.files).filter(([, f]) => f.include).map(([n]) => n) : last.files.map((f) => f.name);
  const differences: string[] = [];
  for (const name of included) {
    const a = last.files.find((f) => f.name === name), b = now.find((f) => f.name === name);
    if (!b) differences.push(`${name} is gone`);
    else if (!a) differences.push(`${name} is new`);
    else if (a.bytes !== b.bytes || a.modified !== b.modified) differences.push(`${name} changed`);
  }
  return { analyzed: true, recipe: Boolean(recipe), lastRunId: last.runId, lastRanAt: last.ranAt, changed: differences.length > 0, differences };
}

/** The folder's files as typed tables with their relations, file access then locked. The caller closes the db. */
async function relatedDb(folder: string, cfg: DataConfig): Promise<{ db: Db; tables: TableSchema[]; relations: Relation[]; skipped: string[] }> {
  const profs = await profiles(folder, cfg);
  const db = await openDb();
  try {
    const { tables, relations } = await loadAndRelate(db, profs, { minOverlap: flags.relationMinOverlap, minShared: flags.relationMinShared, maxDistinct: flags.relationMaxDistinct, maxRelations: flags.relationMax, codeValues: flags.schemaCodeValues });
    await lockFiles(db);
    return { db, tables, relations, skipped: profs.filter((p) => p.tooBig).map((p) => p.name) };
  } catch (e) { db.close(); throw e; }
}

const stored = (b: Record<string, any>): Stored => {
  const s = typeof b.runId === "string" ? runs.get(b.runId) : undefined;
  if (!s) throw new HttpError(404, "unknown or expired runId: run the analysis again");
  return s;
};

createServer(async (req, res) => {
  try {
    if (!hostOk(req)) return send(res, 403, { error: `use http://127.0.0.1:${flags.port}` });
    const path = new URL(req.url ?? "/", "http://analyst").pathname;
    if (req.method === "GET" && path === "/healthz") return send(res, 200, { ok: true, version: VERSION });
    if (req.method !== "POST") return send(res, 404, { error: "not found" });
    const b = await body(req);
    const cfg = readDataConfig(flags);
    if (path === "/profile") {
      const folder = await folderOf(b, cfg);
      const profs = await profiles(folder, cfg);
      return send(res, 200, { folder, folderId: folderId(folder), files: profs, proposal: proposeRecipe(folder, profs), saved: await readRecipe(cfg.workDir, folder) });
    }
    if (path === "/recipe") {
      const folder = await folderOf(b, cfg);
      const recipe = validateRecipe({ ...b.recipe, folder }, await profiles(folder, cfg));
      await saveRecipe(cfg.workDir, recipe);
      return send(res, 200, { ok: true, recipe });
    }
    if (path === "/analyze") return send(res, 200, await runAnalysis(await folderOf(b, cfg), cfg));
    if (path === "/status") return send(res, 200, await status(await folderOf(b, cfg), cfg));
    if (path === "/relations") {
      const folder = await folderOf(b, cfg);
      const r = await relatedDb(folder, cfg);
      r.db.close();
      return send(res, 200, { folder, tables: r.tables, relations: r.relations, skipped: r.skipped, schema: schemaText(r.tables, r.relations) });
    }
    if (path === "/sql") {
      const folder = await folderOf(b, cfg);
      const r = await relatedDb(folder, cfg);
      try { return send(res, 200, await runSelect(r.db, b.sql, { maxRows: flags.sqlMaxRows, timeoutMs: flags.sqlTimeoutMs })); }
      catch (e) { if (e instanceof SqlRefused) throw new HttpError(400, e.message); throw e; }
      finally { r.db.close(); }
    }
    if (path === "/evidence") {
      const s = stored(b);
      const budget = Math.min(flags.evidenceMaxChars, Number.isInteger(b.budget) && b.budget > 0 ? b.budget : flags.evidenceMaxChars);
      try { return send(res, 200, { runId: s.runId, ...evidenceOf(s.analysis, s.findings, budget, flags.evidenceRowsPerFinding) }); }
      catch (e) { throw new HttpError(413, (e as Error).message); }
    }
    if (path === "/verify") {
      stored(b);
      if (typeof b.answer !== "string" || typeof b.evidence !== "string") throw new HttpError(400, "answer and evidence must be strings");
      return send(res, 200, verifyAnswer(b.answer, b.evidence));
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error("[analyst]", e);
    return send(res, 500, { error: (e as Error).message });
  }
}).listen(flags.port, "127.0.0.1", () => {
  let where = "";
  try { const c = readDataConfig(flags); where = ` data: ${c.allowedRoots.join(", ")}; work dir: ${c.workDir}`; } catch (e) { where = ` ${(e as Error).message}`; }
  console.log(`[analyst] http://127.0.0.1:${flags.port}${where}`);
});
