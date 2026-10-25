/**
 * Runs ONE read-only query on the typed tables of a folder (relate.ts), for questions that span files.
 * The query may come from a model, so it is checked and then run with every guard on:
 *   1. checkSelect: a single SELECT (or WITH ... SELECT); no comments, no ";" except one at the end, none of the
 *      statements or functions that touch files, settings or extensions.
 *   2. File access is already switched off and locked (lockFiles) before this runs, so even a query that got past the
 *      check cannot read or write a file.
 *   3. At most maxRows + 1 rows are read (truncated is then true), and the query is interrupted after timeoutMs.
 */
import { type Db, ident } from "./db.ts";

export class SqlRefused extends Error {}

const FORBIDDEN = /\b(attach|detach|copy|export|import|install|load|pragma|set|reset|create|insert|update|delete|drop|alter|truncate|call|checkpoint|vacuum|use|begin|commit|rollback|prepare|execute|summarize|describe|read_csv\w*|read_parquet|read_json\w*|read_text|read_blob|parquet_\w+|glob|sniff_csv|getenv|current_setting|duckdb_\w+|query|query_table|httpfs|http_get|sqlite_\w+|postgres_\w+|mysql_\w+)\b/i;

/** Returns the query without a trailing ";", or throws SqlRefused saying why. String literals are blanked before the keyword check, so WHERE x = 'drop' is fine. */
export function checkSelect(sql: unknown, maxChars = 8000): string {
  if (typeof sql !== "string" || !sql.trim()) throw new SqlRefused("the query is empty");
  if (sql.length > maxChars) throw new SqlRefused(`the query is over ${maxChars} characters`);
  const q = sql.trim().replace(/;\s*$/, "");
  const code = q.replace(/'(?:[^']|'')*'/g, "''"); // literals blanked; identifiers in "..." stay (a column may be named "Charge")
  if (/--|\/\*/.test(code)) throw new SqlRefused("comments are not allowed in the query");
  if (code.includes(";")) throw new SqlRefused("only one statement is allowed");
  if (!/^\s*(select|with)\b/i.test(code)) throw new SqlRefused("the query must start with SELECT or WITH");
  const bare = code.replace(/"(?:[^"]|"")*"/g, '""'); // keywords inside quoted column names are fine too
  const bad = bare.match(FORBIDDEN);
  if (bad) throw new SqlRefused(`"${bad[0]}" is not allowed in a question query`);
  return q;
}

export type SqlResult = { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean; ms: number };

export async function runSelect(db: Db, sql: string, opt: { maxRows: number; timeoutMs: number }): Promise<SqlResult> {
  const q = checkSelect(sql);
  const started = Date.now();
  const timer = setTimeout(() => { try { db.conn.interrupt(); } catch { /* finished */ } }, opt.timeoutMs);
  try {
    const r = await db.conn.runAndReadAll(`SELECT * FROM (${q}) AS ${ident("__q")} LIMIT ${opt.maxRows + 1}`);
    // Floating-point sums come back as 412345.6700000001: rounded to 6 decimals, so the table, the number check and the
    // model all see 412345.67 (and the gateway's residual check does not read the tail as a 10-digit identifier).
    const all = (r.getRowObjectsJson() as Record<string, unknown>[]).map((row) => {
      for (const k of Object.keys(row)) { const v = row[k]; if (typeof v === "number" && Number.isFinite(v) && !Number.isInteger(v)) row[k] = Math.round(v * 1e6) / 1e6; }
      return row;
    });
    return { columns: r.columnNames(), rows: all.slice(0, opt.maxRows), truncated: all.length > opt.maxRows, ms: Date.now() - started };
  } catch (e) {
    if (Date.now() - started >= opt.timeoutMs) throw new SqlRefused(`the query took over ${opt.timeoutMs} ms and was stopped`);
    // Quoted values in DuckDB's message (e.g. a value that would not convert) are blanked: the message may go back to a model.
    throw new SqlRefused(`the query failed: ${(e as Error).message.split("\n")[0].replace(/'[^']*'/g, "'...'")}`);
  } finally { clearTimeout(timer); }
}
