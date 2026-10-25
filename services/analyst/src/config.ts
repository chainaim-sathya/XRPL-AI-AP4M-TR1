/**
 * Flags, the shared data-folder config and path confinement for the analyst.
 *
 * The analyst reads ONLY inside allowedRoots from config/data-sources.json (the same file the test console uses),
 * after resolving links, and only CSV/TSV files. It writes only small, data-free files (recipes, manifests) under
 * --work-dir. It never calls a model and holds no keys.
 */
import { readFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export type Period = "week" | "month" | "quarter";
export type MatchMode = "auto" | "one-to-one" | "many-to-one" | "none";
export type PairMode = "auto" | "tie" | "ratio";

/** Thresholds a folder's recipe may override. */
export type Settings = {
  period: Period;
  baselinePeriods: number;
  variancePct: number;
  varianceAmount: number;
  dateWindowDays: number;
  amountTolerance: number;
  match: MatchMode;
  pairMode: PairMode;
  agingDays: number;
  /** Recipe only: pins the expected later/earlier ratio for ratio pairs instead of the median. */
  expectedRatio?: number | null;
};

export type Flags = Settings & {
  port: number;
  dataConfig: string;
  workDir: string | null;
  evidenceMaxChars: number;
  evidenceRowsPerFinding: number;
  maxFindings: number;
  maxBytes: number;
  maxFiles: number;
  keepFindings: boolean;
  runsInMemory: number;
  /** Cross-file questions (/relations, /sql). */
  relationMinOverlap: number;
  relationMinShared: number;
  relationMaxDistinct: number;
  relationMax: number;
  schemaCodeValues: number;
  sqlMaxRows: number;
  sqlTimeoutMs: number;
};

const positive = (name: string, v: string | undefined, integer = true): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) throw new Error(`--${name} must be a ${integer ? "non-negative integer" : "non-negative number"}, got ${v}`);
  return n;
};

export function parseFlags(argv: string[]): Flags {
  const { values: f } = parseArgs({
    args: argv,
    strict: true,
    options: {
      port: { type: "string", default: "8740" },
      "data-config": { type: "string", default: fileURLToPath(new URL("../../../config/data-sources.json", import.meta.url)) },
      "work-dir": { type: "string" },
      period: { type: "string", default: "month" },
      "baseline-periods": { type: "string", default: "3" },
      "variance-pct": { type: "string", default: "2" },
      "variance-amount": { type: "string", default: "100" },
      "date-window-days": { type: "string", default: "3" },
      "amount-tolerance": { type: "string", default: "0.01" },
      match: { type: "string", default: "auto" },
      "pair-mode": { type: "string", default: "auto" },
      "aging-days": { type: "string", default: "30" },
      "evidence-max-chars": { type: "string", default: "16000" },
      "evidence-rows-per-finding": { type: "string", default: "3" },
      "max-findings": { type: "string", default: "12" },
      "max-bytes": { type: "string", default: "500000000" },
      "max-files": { type: "string", default: "20" },
      "keep-findings": { type: "boolean", default: false },
      "runs-in-memory": { type: "string", default: "10" },
      "relation-min-overlap": { type: "string", default: "0.5" },
      "relation-min-shared": { type: "string", default: "3" },
      "relation-max-distinct": { type: "string", default: "50000" },
      "relation-max": { type: "string", default: "40" },
      "schema-code-values": { type: "string", default: "12" },
      "sql-max-rows": { type: "string", default: "200" },
      "sql-timeout-ms": { type: "string", default: "15000" },
    },
  });
  const period = f.period as Period;
  if (!["week", "month", "quarter"].includes(period)) throw new Error(`--period must be week, month or quarter, got ${f.period}`);
  const match = f.match as MatchMode;
  if (!["auto", "one-to-one", "many-to-one", "none"].includes(match)) throw new Error(`--match must be auto, one-to-one, many-to-one or none, got ${f.match}`);
  const pairMode = f["pair-mode"] as PairMode;
  if (!["auto", "tie", "ratio"].includes(pairMode)) throw new Error(`--pair-mode must be auto, tie or ratio, got ${f["pair-mode"]}`);
  const port = positive("port", f.port);
  if (port < 1 || port > 65535) throw new Error(`--port must be 1 to 65535, got ${f.port}`);
  if (f["work-dir"] !== undefined && !isAbsolute(f["work-dir"])) throw new Error(`--work-dir must be an absolute folder, got ${f["work-dir"]}`);
  return {
    port,
    dataConfig: f["data-config"]!,
    workDir: f["work-dir"] ?? null,
    period,
    baselinePeriods: Math.max(1, positive("baseline-periods", f["baseline-periods"])),
    variancePct: positive("variance-pct", f["variance-pct"], false),
    varianceAmount: positive("variance-amount", f["variance-amount"], false),
    dateWindowDays: positive("date-window-days", f["date-window-days"]),
    amountTolerance: positive("amount-tolerance", f["amount-tolerance"], false),
    match,
    pairMode,
    agingDays: positive("aging-days", f["aging-days"]),
    evidenceMaxChars: Math.max(1000, positive("evidence-max-chars", f["evidence-max-chars"])),
    evidenceRowsPerFinding: positive("evidence-rows-per-finding", f["evidence-rows-per-finding"]),
    maxFindings: Math.max(1, positive("max-findings", f["max-findings"])),
    maxBytes: Math.max(1, positive("max-bytes", f["max-bytes"])),
    maxFiles: Math.max(1, positive("max-files", f["max-files"])),
    keepFindings: f["keep-findings"]!,
    runsInMemory: Math.max(1, positive("runs-in-memory", f["runs-in-memory"])),
    relationMinOverlap: Math.min(1, positive("relation-min-overlap", f["relation-min-overlap"], false)),
    relationMinShared: Math.max(1, positive("relation-min-shared", f["relation-min-shared"])),
    relationMaxDistinct: Math.max(10, positive("relation-max-distinct", f["relation-max-distinct"])),
    relationMax: Math.max(1, positive("relation-max", f["relation-max"])),
    schemaCodeValues: positive("schema-code-values", f["schema-code-values"]),
    sqlMaxRows: Math.max(1, positive("sql-max-rows", f["sql-max-rows"])),
    sqlTimeoutMs: Math.max(100, positive("sql-timeout-ms", f["sql-timeout-ms"])),
  };
}

export const settingsOf = (f: Flags): Settings => ({
  period: f.period, baselinePeriods: f.baselinePeriods, variancePct: f.variancePct, varianceAmount: f.varianceAmount,
  dateWindowDays: f.dateWindowDays, amountTolerance: f.amountTolerance, match: f.match, pairMode: f.pairMode, agingDays: f.agingDays,
});

// ---- data folders (config/data-sources.json, shared with the test console) -------------------------
export type DataConfig = { allowedRoots: string[]; exclude: RegExp[]; hideFolders: RegExp[]; workDir: string };
export const ANALYST_EXTENSIONS = [".csv", ".tsv", ".json"];

const fold = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);
export function within(child: string, root: string): boolean {
  const r = relative(fold(root), fold(child));
  return r === "" || (r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r));
}
export const globToRe = (g: string): RegExp => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** Re-read on every call, like the console, so edits need no restart. */
export function readDataConfig(flags: Flags): DataConfig {
  let raw: Record<string, any>;
  try {
    const text = readFileSync(flags.dataConfig, "utf8");
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    throw new HttpError(503, `cannot read the data config ${flags.dataConfig} (${(e as Error).message}); copy config/data-sources.example.json to config/data-sources.json`);
  }
  const roots: string[] = Array.isArray(raw.allowedRoots) ? raw.allowedRoots.filter((r: unknown) => typeof r === "string" && isAbsolute(r)).map((r: string) => resolve(r)) : [];
  if (!roots.length) throw new HttpError(503, "the data config has no allowedRoots (absolute folders)");
  const exclude = (Array.isArray(raw.exclude) ? raw.exclude.map(String) : []).map(globToRe);
  const hideFolders = (Array.isArray(raw.hideFolders) ? raw.hideFolders.map(String) : ["_*"]).map(globToRe);
  return { allowedRoots: roots, exclude, hideFolders, workDir: flags.workDir ?? join(roots[0], "_analyst") };
}

/** The real path of a requested folder or file, required to be inside an allowed root. Lexical check first (no disk access for paths outside), then the real path (links that lead out are refused). */
export async function insideRoots(p: unknown, cfg: DataConfig): Promise<string> {
  if (typeof p !== "string" || !p || !isAbsolute(p)) throw new HttpError(400, "folder must be an absolute path");
  const asked = resolve(p);
  if (!cfg.allowedRoots.some((r) => within(asked, r))) throw new HttpError(403, "outside the allowed data folders (allowedRoots in the data config)");
  if (within(asked, cfg.workDir)) throw new HttpError(403, "the analyst's own work folder cannot be analyzed");
  let real: string;
  try { real = await realpath(asked); } catch { throw new HttpError(404, `not found: ${asked}`); }
  for (const r of cfg.allowedRoots) {
    let rootReal: string;
    try { rootReal = await realpath(r); } catch { continue; }
    if (within(real, rootReal)) return real;
  }
  throw new HttpError(403, "this path leads outside the allowed data folders (a link?)");
}

export const isDataFile = (name: string, cfg: DataConfig): boolean =>
  ANALYST_EXTENSIONS.includes(extname(name).toLowerCase()) && !name.startsWith(".") && !name.startsWith("_") && !cfg.exclude.some((re) => re.test(basename(name)));

export async function isFolder(p: string): Promise<boolean> { try { return (await stat(p)).isDirectory(); } catch { return false; } }
