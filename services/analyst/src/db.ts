/**
 * DuckDB, in memory, one instance per analysis. Files are loaded as text (all_varchar) so a stray value never breaks
 * type detection; role columns are parsed with TRY_ functions instead. As soon as the files are loaded, file access
 * is switched off and the configuration locked, so nothing after loading can read or write any file.
 */
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

export type Db = { conn: DuckDBConnection; close: () => void };

export async function openDb(): Promise<Db> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  return { conn, close: () => { try { conn.closeSync(); } catch { /* already closed */ } try { instance.closeSync(); } catch { /* already closed */ } } };
}

export const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;
export const literal = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export async function rows<T = Record<string, unknown>>(db: Db, sql: string): Promise<T[]> {
  return (await db.conn.runAndReadAll(sql)).getRowObjectsJson() as T[];
}

/**
 * Loads one CSV/TSV/JSON file as text into a table with __row = its record number (1 = first row after the header, or
 * the first record). The path is a real path already confined to the allowed roots.
 * JSON: an array of records, or an ERPNext/Frappe REST answer {"data": [records]} (also {"message": [...]}); nested
 * objects become columns (a.b), lists stay as text. Every value is loaded as text, like the CSV files.
 */
export async function loadText(db: Db, table: string, path: string): Promise<void> {
  if (/\.json$/i.test(path)) return loadJson(db, table, path);
  const delim = /\.tsv$/i.test(path) ? ", delim='\\t'" : "";
  await db.conn.run(`CREATE TABLE ${ident(table)} AS SELECT CAST(row_number() OVER () AS INTEGER) AS __row, * FROM read_csv(${literal(path)}, header=true, all_varchar=true${delim})`);
}

async function loadJson(db: Db, table: string, path: string): Promise<void> {
  const src = `read_json(${literal(path)}, format = 'auto', maximum_object_size = 64000000)`;
  const top = await rows<{ column_name: string; column_type: string }>(db, `SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM ${src})`);
  const wrapped = top.length === 1 && /^(data|message)$/.test(top[0].column_name) && /^STRUCT\(.*\)\[\]$/s.test(top[0].column_type);
  if (top.length === 1 && /^(data|message)$/.test(top[0].column_name) && !wrapped) throw new Error(`${path}: "${top[0].column_name}" is not a list of records`);
  const records = wrapped ? `(SELECT unnest(${ident(top[0].column_name)}, recursive := true) FROM ${src})` : src;
  const cols = (await rows<{ column_name: string }>(db, `SELECT column_name FROM (DESCRIBE SELECT * FROM ${records})`)).map((c) => c.column_name);
  if (!cols.length) throw new Error(`${path}: no records`);
  await db.conn.run(`CREATE TABLE ${ident(table)} AS SELECT CAST(row_number() OVER () AS INTEGER) AS __row, ${cols.map((c) => `CAST(${ident(c)} AS VARCHAR) AS ${ident(c)}`).join(", ")} FROM ${records}`);
}

/** After loading: no more file reads or writes from SQL, and that cannot be switched back on. */
export async function lockFiles(db: Db): Promise<void> {
  await db.conn.run("SET enable_external_access = false");
  await db.conn.run("SET lock_configuration = true");
}

/** SQL turning a text column into a DATE. A recipe can fix the format (strptime syntax); otherwise ISO, US (m/d/Y) and then day-first are tried, in that order. */
export function dateExpr(col: string, format: string | null | undefined): string {
  const c = `trim(${ident(col)})`;
  if (format) return `CAST(try_strptime(${c}, ${literal(format)}) AS DATE)`;
  const formats = ["%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%d/%m/%Y", "%Y/%m/%d", "%d-%b-%Y", "%b %d %Y", "%Y-%m-%d %H:%M:%S", "%m/%d/%Y %H:%M"];
  return `CAST(coalesce(${formats.map((f) => `try_strptime(${c}, ${literal(f)})`).join(", ")}) AS DATE)`;
}

/**
 * SQL turning a text column into a number. Only currency symbols, spaces, signs, parentheses, digits and separators
 * are accepted (so "CLM-100000" or "D0120" are not numbers); (123.45) and a trailing minus mean negative.
 */
export function amountExpr(col: string): string {
  const c = `trim(${ident(col)})`;
  const cleaned = `regexp_replace(${c}, '[^0-9.()\\-]', '', 'g')`;
  return `CASE WHEN ${c} IS NULL OR ${c} = '' THEN NULL
    WHEN NOT regexp_full_match(${c}, '[\\s$€£¥₹+\\-()0-9.,]+') OR NOT regexp_matches(${c}, '[0-9]') THEN NULL
    WHEN ${cleaned} LIKE '(%)' THEN -TRY_CAST(regexp_replace(${cleaned}, '[()]', '', 'g') AS DOUBLE)
    WHEN ${cleaned} LIKE '%-' THEN -TRY_CAST(rtrim(${cleaned}, '-') AS DOUBLE)
    ELSE TRY_CAST(${cleaned} AS DOUBLE) END`;
}
