/**
 * Cross-file relations: which columns in DIFFERENT files of one folder hold the same things (a claim number, a patient,
 * a payer), so a question can be answered by joining the files. Found from the VALUES (DuckDB, distinct values of each
 * candidate column, normalized as upper(trim(v))), with the column names as a tie-breaker; a relation is never
 * proposed from the names alone. The result is a map of file, column, overlap and cardinality: no data values.
 *
 * Also builds the typed tables a question is answered on (see sqlrun.ts): one table per file, named after the file,
 * number columns as DOUBLE (amountExpr), date columns as DATE (dateExpr), text as text, plus __row.
 *
 *   overlap   = shared distinct values / distinct values of the SMALLER side (containment: 1 = every value of one side
 *               is found in the other, e.g. every paid claim is a billed claim)
 *   key       = at least one side is unique per row (an id); otherwise "category" (a payer, a method), which joins
 *               many rows to many and is shown so the model groups by it rather than joins on it
 *   confidence = 0.8 x overlap + 0.2 x nameScore
 */
import { type Db, amountExpr, dateExpr, ident, loadText, rows } from "./db.ts";
import { type FileProfile } from "./profile.ts";

export type RelateOptions = {
  /** Least overlap (containment) for a relation (default 0.5). */
  minOverlap: number;
  /** Least number of shared distinct values (default 3), so two tiny code lists do not "relate" by chance. */
  minShared: number;
  /** Distinct values compared per column at most (default 50000); a bigger column is compared on that many. */
  maxDistinct: number;
  /** Most relations returned, best first (default 40). */
  maxRelations: number;
  /** Code columns (named like status, type, method, category, currency, stage, kind) with at most this many distinct
   * values get their values listed in the schema text, so a model can write WHERE "status" = 'Overdue'. 0 = off. Default 12.
   * Only those column names, so names, ids and amounts never appear. */
  codeValues: number;
};
export const RELATE_DEFAULTS: RelateOptions = { minOverlap: 0.5, minShared: 3, maxDistinct: 50000, maxRelations: 40, codeValues: 12 };
export const CODE_COLUMN = /(^|[^a-z])(status|state|type|method|category|currency|stage|kind|mode|channel)([^a-z]|$)/i;

export type TableColumn = { name: string; type: "date" | "number" | "text"; values?: string[] };
export type TableSchema = { table: string; file: string; rows: number; columns: TableColumn[] };
export type Relation = {
  a: { file: string; table: string; column: string; distinct: number; unique: boolean };
  b: { file: string; table: string; column: string; distinct: number; unique: boolean };
  shared: number; overlap: number; nameScore: number; confidence: number;
  link: "key" | "category";
  cardinality: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";
};

/** The SQL table name for a file: its name without the extension, lower case, letters, digits and _ only; t_ in front when it would start with a digit; _2, _3 ... on a clash. */
export function tableNames(files: string[]): Map<string, string> {
  const out = new Map<string, string>(), used = new Set<string>(["__row"]);
  for (const f of files) {
    let base = f.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "file";
    if (/^\d/.test(base)) base = "t_" + base;
    let name = base, n = 2;
    while (used.has(name)) name = `${base}_${n++}`;
    used.add(name); out.set(f, name);
  }
  return out;
}

const SYNONYMS: [RegExp, string][] = [[/^(#|no|num|nbr|number|id|identifier|code)$/, "id"], [/^(clm)$/, "claim"], [/^(pt|pat)$/, "patient"], [/^(inv)$/, "invoice"], [/^(acct|acc)$/, "account"], [/^(cust)$/, "customer"]];
const tokens = (name: string): Set<string> => new Set(name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/#/g, " # ").split(/[^a-z0-9#]+/).filter(Boolean)
  .map((t) => SYNONYMS.find(([re]) => re.test(t))?.[1] ?? t));
/** 1 for the same name (ignoring case, spaces and punctuation), else the token Jaccard (with a few synonyms: # = no = id, pt = patient, ...). */
export function nameScore(x: string, y: string): number {
  const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9#]/g, "");
  if (flat(x) === flat(y)) return 1;
  const a = tokens(x), b = tokens(y);
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const t of a) if (b.has(t)) both++;
  return Math.round((both / (a.size + b.size - both)) * 100) / 100;
}

/** A column worth comparing: text (not a date), or a number that looks like an id (whole numbers, or an id-like name). Money columns never are. */
function candidate(c: FileProfile["columns"][number]): boolean {
  if (c.filled === 0 || c.type === "date") return false;
  if (c.type === "text") return true;
  return /(^|[^a-z])(id|no|num|number|code|ref|account|acct|zip|npi|mrn)([^a-z]|$)|#/i.test(c.name) && c.samples.every((s) => /^\d+$/.test(s.trim()));
}

/**
 * Loads every file of the folder (profiles from profileFolder, tooBig files skipped) into typed tables and finds the
 * relations. The caller locks file access afterwards (lockFiles) before running any question on these tables.
 */
export async function loadAndRelate(db: Db, profiles: FileProfile[], opt: RelateOptions = RELATE_DEFAULTS): Promise<{ tables: TableSchema[]; relations: Relation[] }> {
  const usable = profiles.filter((p) => !p.tooBig && p.columns.length);
  const names = tableNames(usable.map((p) => p.name));
  const tables: TableSchema[] = [];
  for (const [i, p] of usable.entries()) {
    const raw = `__raw${i}`, t = names.get(p.name)!;
    await loadText(db, raw, p.path);
    const cols = p.columns.map((c) => `${c.type === "number" ? amountExpr(c.name) : c.type === "date" ? dateExpr(c.name, null) : `NULLIF(trim(${ident(c.name)}), '')`} AS ${ident(c.name)}`);
    await db.conn.run(`CREATE TABLE ${ident(t)} AS SELECT __row, ${cols.join(", ")} FROM ${ident(raw)}`);
    // Distinct normalized values of each candidate column, kept for the comparison only.
    for (const [j, c] of p.columns.entries()) {
      if (!candidate(c)) continue;
      await db.conn.run(`CREATE TEMP TABLE ${ident(`__v${i}_${j}`)} AS SELECT DISTINCT upper(trim(${ident(c.name)})) v FROM ${ident(raw)} WHERE trim(${ident(c.name)}) <> '' LIMIT ${opt.maxDistinct}`);
    }
    await db.conn.run(`DROP TABLE ${ident(raw)}`);
    const columns: TableColumn[] = [];
    for (const c of p.columns) {
      const col: TableColumn = { name: c.name, type: c.type };
      if ((opt.codeValues ?? 0) > 0 && c.type === "text" && CODE_COLUMN.test(c.name)) {
        const vals = (await rows<{ v: string }>(db, `SELECT DISTINCT ${ident(c.name)} v FROM ${ident(t)} WHERE ${ident(c.name)} IS NOT NULL ORDER BY 1 LIMIT ${opt.codeValues + 1}`)).map((x) => String(x.v));
        if (vals.length && vals.length <= opt.codeValues && vals.every((v) => v.length <= 40)) col.values = vals;
      }
      columns.push(col);
    }
    tables.push({ table: t, file: p.name, rows: p.rows, columns });
  }
  // Per candidate: distinct count and whether it is unique per row.
  type Cand = { i: number; j: number; file: string; table: string; column: string; distinct: number; unique: boolean };
  const cands: Cand[] = [];
  for (const [i, p] of usable.entries()) {
    for (const [j, c] of p.columns.entries()) {
      if (!candidate(c)) continue;
      const [s] = await rows<{ d: number }>(db, `SELECT CAST(count(*) AS INTEGER) d FROM ${ident(`__v${i}_${j}`)}`);
      if (s.d < opt.minShared) continue;
      // Unique per row: compared with the filled rows of the WHOLE file (the profile's count covers only its sample).
      const [f] = await rows<{ n: number }>(db, `SELECT CAST(count(${ident(c.name)}) AS INTEGER) n FROM ${ident(names.get(p.name)!)}`);
      cands.push({ i, j, file: p.name, table: names.get(p.name)!, column: c.name, distinct: s.d, unique: s.d === f.n });
    }
  }
  const relations: Relation[] = [];
  for (const x of cands) for (const y of cands) {
    if (x.i >= y.i) continue; // different files, each pair once
    const [s] = await rows<{ n: number }>(db, `SELECT CAST(count(*) AS INTEGER) n FROM ${ident(`__v${x.i}_${x.j}`)} JOIN ${ident(`__v${y.i}_${y.j}`)} USING (v)`);
    const overlap = Math.round((s.n / Math.min(x.distinct, y.distinct)) * 10000) / 10000;
    if (s.n < opt.minShared || overlap < opt.minOverlap) continue;
    const ns = nameScore(x.column, y.column);
    const cardinality = x.unique && y.unique ? "one-to-one" : x.unique ? "one-to-many" : y.unique ? "many-to-one" : "many-to-many";
    // A key: one side is unique per row, or both have many distinct values (an id repeated across payments).
    const link = x.unique || y.unique || Math.min(x.distinct, y.distinct) >= 50 ? "key" : "category";
    const side = (c: Cand) => ({ file: c.file, table: c.table, column: c.column, distinct: c.distinct, unique: c.unique });
    relations.push({ a: side(x), b: side(y), shared: s.n, overlap, nameScore: ns, confidence: Math.round((0.8 * overlap + 0.2 * ns) * 100) / 100, link, cardinality });
  }
  for (const c of cands) await db.conn.run(`DROP TABLE ${ident(`__v${c.i}_${c.j}`)}`);
  // Drop any temp value tables of candidates that had too few values.
  for (const t of await rows<{ name: string }>(db, "SELECT table_name AS name FROM duckdb_tables() WHERE starts_with(table_name, '__v')")) await db.conn.run(`DROP TABLE ${ident(t.name)}`);
  relations.sort((p, q) => Number(q.link === "key") - Number(p.link === "key") || q.confidence - p.confidence || q.shared - p.shared);
  return { tables, relations: relations.slice(0, opt.maxRelations) };
}

/** The text a model gets to write a query: tables, columns and types, and the relations. No data values. */
export function schemaText(tables: TableSchema[], relations: Relation[]): string {
  const lines = ["Tables (DuckDB; one per file; number columns are DOUBLE, date columns are DATE, others VARCHAR; __row = line number in the file):"];
  for (const t of tables) lines.push(`- ${t.table}  (file ${t.file}, ${t.rows} rows): ${t.columns.map((c) => `"${c.name}" ${c.type === "number" ? "DOUBLE" : c.type === "date" ? "DATE" : "VARCHAR"}${c.values ? ` (values: ${c.values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ")})` : ""}`).join(", ")}`);
  lines.push("", relations.length ? "Relations found from the values (join keys match after upper(trim(...))):" : "No relations between the files were found from the values.");
  for (const r of relations) {
    lines.push(`- ${r.a.table}."${r.a.column}" ~ ${r.b.table}."${r.b.column}": ${r.link}, ${r.cardinality}, ${Math.round(r.overlap * 100)}% overlap (${r.shared} shared values)`);
  }
  return lines.join("\n");
}
