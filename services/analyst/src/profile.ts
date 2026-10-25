/**
 * Profile every CSV/TSV in a folder and PROPOSE a recipe: what each column means (roles), what each file is (kind),
 * which amounts count (measure) and the order money flows through the files. The proposal is made by rules on column
 * names and value types, so it is deterministic; the person confirms or fixes it, and the saved recipe is reused.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type DataConfig, HttpError, type Settings, isDataFile } from "./config.ts";
import { type Db, amountExpr, dateExpr, ident, loadText, rows } from "./db.ts";

export const ROLES = ["date", "amount", "debit", "credit", "party", "reference", "category"] as const;
export type Role = (typeof ROLES)[number];
export const KINDS = ["production", "billing", "income", "collections", "deposits", "ledger", "tax", "adjustments", "other"] as const;
export type Kind = (typeof KINDS)[number];
export const MEASURES = ["net", "inflows", "outflows", "abs"] as const;
export type Measure = (typeof MEASURES)[number];

export type FileRecipe = { kind: Kind; roles: Partial<Record<Role, string>>; measure: Measure; dateFormat?: string | null; include: boolean };
export type Recipe = { version: 1; folder: string; files: Record<string, FileRecipe>; flow: string[]; settings?: Partial<Settings>; confirmedAt?: string };

export type ColumnProfile = { name: string; type: "date" | "number" | "text"; filled: number; samples: string[] };
export type FileProfile = { name: string; path: string; bytes: number; modified: string; rows: number; columns: ColumnProfile[]; dateRange: { from: string; to: string } | null; tooBig: boolean };

export async function listDataFiles(folder: string, cfg: DataConfig, maxFiles: number): Promise<{ name: string; path: string; bytes: number; modified: string }[]> {
  const entries = (await readdir(folder, { withFileTypes: true })).filter((e) => e.isFile() && !e.isSymbolicLink() && isDataFile(e.name, cfg)).sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length > maxFiles) throw new HttpError(413, `${entries.length} data files in this folder; the limit is --max-files ${maxFiles}`);
  const out = [];
  for (const e of entries) {
    const path = join(folder, e.name);
    const s = await stat(path);
    out.push({ name: e.name, path, bytes: s.size, modified: s.mtime.toISOString() });
  }
  return out;
}

const SAMPLE = 2000;
/** Profiles one loaded table: per column, what share of a sample parses as a date or a number. */
export async function profileTable(db: Db, table: string, file: { name: string; path: string; bytes: number; modified: string }): Promise<FileProfile> {
  const cols = (await rows<{ column_name: string }>(db, `SELECT column_name FROM (DESCRIBE ${ident(table)})`)).map((c) => c.column_name).filter((c) => c !== "__row");
  const [{ n }] = await rows<{ n: number }>(db, `SELECT CAST(count(*) AS INTEGER) n FROM ${ident(table)}`);
  const columns: ColumnProfile[] = [];
  for (const c of cols) {
    const [st] = await rows<{ filled: number; dates: number; nums: number }>(db, `SELECT
      CAST(count(${ident(c)}) FILTER (WHERE trim(${ident(c)}) <> '') AS INTEGER) filled,
      CAST(count(*) FILTER (WHERE ${dateExpr(c, null)} IS NOT NULL) AS INTEGER) dates,
      CAST(count(*) FILTER (WHERE ${amountExpr(c)} IS NOT NULL) AS INTEGER) nums
      FROM (SELECT ${ident(c)} FROM ${ident(table)} LIMIT ${SAMPLE})`);
    const samples = (await rows<{ v: string }>(db, `SELECT ${ident(c)} v FROM ${ident(table)} WHERE trim(${ident(c)}) <> '' LIMIT 3`)).map((r) => String(r.v));
    const base = Math.max(1, st.filled);
    const type = st.dates / base >= 0.9 ? "date" : st.nums / base >= 0.9 ? "number" : "text";
    columns.push({ name: c, type, filled: st.filled, samples });
  }
  let dateRange: FileProfile["dateRange"] = null;
  const dateCol = columns.find((c) => c.type === "date");
  if (dateCol) {
    const [r] = await rows<{ f: string | null; t: string | null }>(db, `SELECT CAST(min(d) AS VARCHAR) f, CAST(max(d) AS VARCHAR) t FROM (SELECT ${dateExpr(dateCol.name, null)} d FROM ${ident(table)})`);
    if (r.f && r.t) dateRange = { from: r.f, to: r.t };
  }
  return { ...file, rows: n, columns, dateRange, tooBig: false };
}

// ---- the proposal --------------------------------------------------------------------------------------
const NAME_HINTS: [Role, RegExp][] = [
  ["date", /date|posted|dos\b|day|time|period/i],
  ["debit", /debit|withdraw|money ?out|\bdr\b/i],
  ["credit", /credit|money ?in|\bcr\b/i],
  ["amount", /amount|amt|total|paid|payment|charge|fee|deposit|value|balance|net|gross|price|sum/i],
  ["reference", /ref|check|cheque|claim|invoice|inv\b|txn|transaction ?id|\bid\b|number|no\b|#|confirmation|batch/i],
  ["party", /payer|patient|vendor|customer|client|name|payee|merchant|counterparty|description|memo|narration|details/i],
  ["category", /category|type|code|class|cpt|method|account|gl|department|service/i],
];
const KIND_HINTS: [Kind, RegExp][] = [
  ["production", /prod|charge|service|encounter|visit/i],
  ["billing", /bill|claim|invoice(?!.*paid)/i],
  ["collections", /collect|payment|receipt|remit|era|paid/i],
  ["deposits", /bank|deposit|statement|stmt/i],
  ["ledger", /erp|ledger|\bgl\b|journal|quickbooks|qbo|xero|books/i],
  ["adjustments", /adjust|write.?off|refund|void/i],
  ["tax", /tax|1040|1120|return|itr/i],
  ["income", /income|revenue|sales|p&l|pnl|profit/i],
];
const FLOW_ORDER: Kind[] = ["production", "billing", "income", "collections", "deposits", "ledger", "tax"];
const DEFAULT_MEASURE: Record<Kind, Measure> = { production: "abs", billing: "abs", income: "abs", collections: "abs", deposits: "inflows", ledger: "net", tax: "abs", adjustments: "abs", other: "net" };

export function proposeFile(p: FileProfile): FileRecipe {
  const roles: Partial<Record<Role, string>> = {};
  const used = new Set<string>();
  const pick = (role: Role, ok: (c: ColumnProfile) => boolean) => {
    const hint = NAME_HINTS.find(([r]) => r === role)![1];
    const c = p.columns.find((c) => !used.has(c.name) && ok(c) && hint.test(c.name)) ?? null;
    if (c) { roles[role] = c.name; used.add(c.name); }
  };
  pick("date", (c) => c.type === "date");
  if (!roles.date) { const c = p.columns.find((c) => c.type === "date"); if (c) { roles.date = c.name; used.add(c.name); } }
  pick("debit", (c) => c.type === "number");
  pick("credit", (c) => c.type === "number");
  if (!(roles.debit && roles.credit)) {
    for (const r of ["debit", "credit"] as const) if (roles[r]) { used.delete(roles[r]!); delete roles[r]; }
    pick("amount", (c) => c.type === "number");
    if (!roles.amount) { const c = p.columns.find((c) => !used.has(c.name) && c.type === "number"); if (c) { roles.amount = c.name; used.add(c.name); } }
  }
  pick("reference", (c) => c.type !== "date");
  // Party: the most useful counterparty first (payer/customer/vendor), then people, then free-text descriptions.
  for (const re of [/payer|insur|plan|customer|client|vendor|supplier|merchant|counterparty|payee/i, /patient|member|name/i, /description|memo|narration|details|particulars/i]) {
    if (roles.party) break;
    const c = p.columns.find((c) => !used.has(c.name) && c.type === "text" && re.test(c.name));
    if (c) { roles.party = c.name; used.add(c.name); }
  }
  pick("category", (c) => c.type === "text");
  const label = `${p.name} ${p.columns.map((c) => c.name).join(" ")}`;
  const kind = (KIND_HINTS.find(([, re]) => re.test(p.name)) ?? KIND_HINTS.find(([, re]) => re.test(label)) ?? ["other"])[0] as Kind;
  return { kind, roles, measure: DEFAULT_MEASURE[kind], dateFormat: null, include: Boolean(roles.date && (roles.amount || (roles.debit && roles.credit))) };
}

export function proposeRecipe(folder: string, profiles: FileProfile[]): Recipe {
  const files: Record<string, FileRecipe> = {};
  for (const p of profiles) files[p.name] = proposeFile(p);
  const flow = profiles.map((p) => p.name).filter((n) => files[n].include && files[n].kind !== "adjustments")
    .sort((a, b) => rank(files[a].kind) - rank(files[b].kind) || a.localeCompare(b));
  return { version: 1, folder, files, flow };
}
const rank = (k: Kind): number => { const i = FLOW_ORDER.indexOf(k); return i === -1 ? 99 : i; };

/** Checks a recipe against the folder's profiles: every included file exists and every role names a real column. */
export function validateRecipe(r: unknown, profiles: FileProfile[]): Recipe {
  const bad = (m: string): never => { throw new HttpError(400, `recipe: ${m}`); };
  if (!r || typeof r !== "object") bad("must be an object");
  const rec = r as Recipe;
  if (!rec.files || typeof rec.files !== "object") bad("files is required");
  const byName = new Map(profiles.map((p) => [p.name, p]));
  for (const [name, f] of Object.entries(rec.files)) {
    const p = byName.get(name) ?? bad(`file ${name} is not in this folder`);
    if (!KINDS.includes(f.kind)) bad(`${name}: kind must be one of ${KINDS.join(", ")}`);
    if (!MEASURES.includes(f.measure)) bad(`${name}: measure must be one of ${MEASURES.join(", ")}`);
    for (const [role, col] of Object.entries(f.roles ?? {})) {
      if (!ROLES.includes(role as Role)) bad(`${name}: unknown role ${role}`);
      if (col && !p.columns.some((c) => c.name === col)) bad(`${name}: column "${col}" (role ${role}) does not exist`);
    }
    if (f.include && !f.roles?.date) bad(`${name}: an included file needs a date column`);
    if (f.include && !f.roles?.amount && !(f.roles?.debit && f.roles?.credit)) bad(`${name}: an included file needs an amount column, or both debit and credit`);
  }
  const flow = Array.isArray(rec.flow) ? rec.flow : bad("flow must be a list of file names");
  for (const n of flow) if (!rec.files[n]?.include) bad(`flow names ${n}, which is not an included file`);
  return { version: 1, folder: rec.folder, files: rec.files, flow, settings: rec.settings ?? {}, confirmedAt: new Date().toISOString() };
}

// ---- recipes and manifests on disk (no data in either) ---------------------------------------------
export const folderId = (folder: string): string => createHash("sha256").update(process.platform === "win32" ? folder.toLowerCase() : folder).digest("hex").slice(0, 16);

export async function readRecipe(workDir: string, folder: string): Promise<Recipe | null> {
  try { return JSON.parse(await readFile(join(workDir, "recipes", `${folderId(folder)}.json`), "utf8")); } catch { return null; }
}
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}
export const saveRecipe = (workDir: string, recipe: Recipe): Promise<void> => writeJson(join(workDir, "recipes", `${folderId(recipe.folder)}.json`), recipe);

export function sha256File(path: string): Promise<string> {
  return new Promise((ok, no) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (c) => h.update(c)).on("error", no).on("end", () => ok(h.digest("hex")));
  });
}

/** Profiles every data file in the folder (loading each into a throwaway DuckDB). */
export async function profileFolder(folder: string, cfg: DataConfig, maxFiles: number, maxBytes: number, open: () => Promise<Db>): Promise<FileProfile[]> {
  const files = await listDataFiles(folder, cfg, maxFiles);
  const db = await open();
  try {
    const out: FileProfile[] = [];
    for (const [i, f] of files.entries()) {
      if (f.bytes > maxBytes) { out.push({ ...f, rows: 0, columns: [], dateRange: null, tooBig: true }); continue; }
      await loadText(db, `p${i}`, f.path);
      out.push(await profileTable(db, `p${i}`, f));
    }
    return out;
  } finally { db.close(); }
}
