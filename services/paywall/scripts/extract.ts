/**
 * F3: the text of a user's document, read on this machine before masking.
 * Nothing in this file sends anything anywhere: it turns a file into the
 * plain text that scripts/private-ask-core.ts then masks, self-checks and
 * (only then) sends.
 *
 *   txt, md     read as UTF-8
 *   pdf         the text layer of every page (unpdf, a packaged pdf.js); a PDF
 *               with no text at all (a scan) is refused: there is no OCR
 *   docx        the document's text (mammoth)
 *   xlsx        every sheet's cells (exceljs); formulas give their last result,
 *               never the formula itself; dates are written YYYY-MM-DD
 *   csv         parsed here (RFC 4180: quoted fields, commas and line breaks in quotes)
 *
 * Images, old binary Office files (.doc, .xls, .ppt) and anything else are
 * refused with a message saying what to do instead.
 *
 * Why tables are "labelled" by default: the gateway's date-of-birth and
 * bank-account detectors only fire when a context word ("birth", "DOB",
 * "account", "bank") is next to the value (services/gateway/src/privacy/entities.ts).
 * A row flattened to "Ravi Kumar 1975-06-02 123456789012" has none, so those
 * values would go through unmasked. Labelled output writes each cell as
 * "Column header: value" on its own line, which keeps the header beside the
 * value for both this machine's masker and the gateway's Presidio. "grid"
 * (one line per row, cells separated by " | ") is smaller but weakens that
 * detection; it is there for large, non-personal tables.
 */
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

/** The document types this file can read. */
export const DOC_TYPES = ["txt", "md", "pdf", "docx", "xlsx", "csv"] as const;
export type DocType = (typeof DOC_TYPES)[number];

/** File extension (lower case, with the dot) -> type. */
export const EXTENSIONS: Readonly<Record<string, DocType>> = {
  ".txt": "txt",
  ".text": "txt",
  ".md": "md",
  ".pdf": "pdf",
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".csv": "csv",
};

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif"]);
/** Old binary Office formats, and what to save them as. */
const OLD_FORMATS: Readonly<Record<string, string>> = { ".doc": ".docx", ".xls": ".xlsx", ".ppt": ".pptx" };

export const TABLE_FORMATS = ["labelled", "grid"] as const;
export type TableFormat = (typeof TABLE_FORMATS)[number];
export const TABLE_HEADERS = ["first-row", "none"] as const;
export type TableHeader = (typeof TABLE_HEADERS)[number];

export type ExtractOptions = {
  /** Which types are accepted; all of DOC_TYPES when unset. */
  types?: readonly DocType[];
  /** How spreadsheet and CSV rows are written; "labelled" when unset (see the file comment). */
  tableFormat?: TableFormat;
  /** Whether a table's first row holds the column names; "first-row" when unset. */
  tableHeader?: TableHeader;
  /** CSV field separator: one character; "," when unset. */
  csvDelimiter?: string;
  /** Largest file read, in bytes; 20 MiB when unset. */
  maxBytes?: number;
  /** Longest text produced, in characters; reading stops and the file is refused beyond it. 1,000,000 when unset. */
  maxChars?: number;
};

export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_CHARS = 1_000_000;

export type Extracted = {
  type: DocType;
  text: string;
  /** What was read, for the screen: "2 pages", "2 sheets, 4 rows". Never any of the text. */
  detail: string;
  /** Things the user should know, such as pages with no text. Never any of the text. */
  warnings: string[];
};

/** The file could not be read as a document; nothing was sent. The message names no value from the file. */
export class DocumentRefused extends Error {}

/** The document type of a file name, or undefined when it is not one this file reads. */
export function documentType(file: string): DocType | undefined {
  return EXTENSIONS[extname(file).toLowerCase()];
}

/** Parse a comma-separated --doc-types value: type names or "all". */
export function parseDocTypes(value: string): DocType[] {
  const v = value.trim().toLowerCase();
  if (v === "all" || v === "") return [...DOC_TYPES];
  const out: DocType[] = [];
  for (const part of v.split(",").map((p) => p.trim()).filter(Boolean)) {
    if (!(DOC_TYPES as readonly string[]).includes(part)) throw new Error(`unknown document type ${part}; use all or ${DOC_TYPES.join(",")}`);
    if (!out.includes(part as DocType)) out.push(part as DocType);
  }
  return out;
}

/** Why a file of this name is not read, or undefined when it can be. */
export function refusalFor(file: string, types: readonly DocType[] = DOC_TYPES): string | undefined {
  const ext = extname(file).toLowerCase();
  const accepted = types.map((t) => `.${t}`).join(", ");
  if (IMAGE_EXTENSIONS.has(ext)) {
    return `${file} is an image; ChainAim cannot read text in images (there is no OCR), so nothing was sent. Type the text into a .txt file instead`;
  }
  if (OLD_FORMATS[ext]) return `${file} is an old ${ext} file; open it and save it as ${OLD_FORMATS[ext]}, then ask again`;
  const type = EXTENSIONS[ext];
  if (type === undefined) return `${file}: ${ext || "files without an extension"} cannot be read; use ${accepted}`;
  if (!types.includes(type)) return `${file}: .${type} files are switched off here (--doc-types); use ${accepted}`;
  return undefined;
}

/** Collapse runs of blank lines and trailing spaces, so the text is no longer than it needs to be. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Throws when the text has grown past the limit, before more is built. */
function guard(length: number, maxChars: number, file: string): void {
  if (length > maxChars) throw new DocumentRefused(`${file} holds more than ${maxChars} characters of text; split it into smaller files; nothing was sent`);
}

// --- tables (xlsx and csv) ---

/** "Column C" for the 3rd column. */
function columnName(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return `Column ${s}`;
}

/**
 * One table as text. Labelled: a "Columns: ..." line with the first row (when
 * it is the header), then a block per row, one "Header: value" line per
 * non-empty cell. Grid: the header line, then one line per row, " | " between
 * cells. Line breaks inside a cell become spaces either way.
 *
 * The header row is always written out, never only used as labels: a sheet
 * laid out as key/value pairs has data in its first row (an e-mail address,
 * say), and that must reach the masker rather than disappear.
 */
export function renderTable(rows: readonly (readonly string[])[], options: { tableFormat?: TableFormat; tableHeader?: TableHeader } = {}): string {
  const clean = rows.map((r) => r.map((c) => c.replace(/\s*[\r\n]+\s*/g, " ").trim()));
  const nonEmpty = clean.filter((r) => r.some((c) => c !== ""));
  if (nonEmpty.length === 0) return "";
  const width = Math.max(...nonEmpty.map((r) => r.length));
  const hasHeader = (options.tableHeader ?? "first-row") === "first-row";
  const header = Array.from({ length: width }, (_, i) => (hasHeader && nonEmpty[0][i]) || columnName(i));
  const body = hasHeader ? nonEmpty.slice(1) : nonEmpty;
  if ((options.tableFormat ?? "labelled") === "grid") {
    return [header.join(" | "), ...body.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | "))].join("\n");
  }
  const blocks = body
    .map((r) =>
      r
        .map((cell, i) => (cell === "" ? undefined : `${header[i]}: ${cell}`))
        .filter((line): line is string => line !== undefined)
        .join("\n"),
    )
    .filter((block) => block !== "");
  const columns = hasHeader ? [`Columns: ${nonEmpty[0].filter((c) => c !== "").join(" | ")}`] : [];
  return [...columns, ...blocks].join("\n\n");
}

/**
 * RFC 4180 CSV: fields separated by `delimiter`, rows by CRLF or LF, a field
 * in double quotes may hold the separator, line breaks and "" for a quote.
 * A quote that is never closed is refused rather than guessed at.
 */
export function parseCsv(text: string, delimiter = ","): string[][] {
  if (delimiter.length !== 1 || delimiter === '"' || delimiter === "\n" || delimiter === "\r") throw new Error("the CSV separator must be one character other than a quote or a line break");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      i++;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
      i++;
    } else if (ch === "\r" || ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += ch === "\r" && s[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (quoted) throw new DocumentRefused("a quoted field is never closed");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** A spreadsheet cell's value as text. A formula gives its last result only; an error cell gives nothing. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    return Number.isInteger(value) && Math.abs(value) < 1e21 ? value.toFixed(0) : String(value);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    const iso = value.toISOString();
    // Excel dates have no zone; exceljs gives them as UTC. A whole day is written as the date alone.
    return iso.slice(11, 19) === "00:00:00" ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  }
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.richText)) return (v.richText as { text?: unknown }[]).map((r) => (typeof r.text === "string" ? r.text : "")).join("");
    if ("formula" in v || "sharedFormula" in v) return cellText(v.result);
    if ("error" in v) return "";
    if (typeof v.text === "string") return v.text; // a hyperlink: its shown text, not the address
    if ("text" in v) return cellText(v.text);
  }
  return "";
}

// --- the readers ---

async function readPdf(bytes: Buffer, file: string, maxChars: number): Promise<Omit<Extracted, "type">> {
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") throw new DocumentRefused(`${file} is not a PDF file (it does not start like one); nothing was sent`);
  const { getDocumentProxy, extractText } = await import("unpdf");
  let pages: string[];
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const result = await extractText(pdf, { mergePages: false });
    pages = (Array.isArray(result.text) ? result.text : [result.text]).map((p) => tidy(String(p)));
  } catch (e) {
    const name = (e as { name?: unknown } | null)?.name;
    if (name === "PasswordException") throw new DocumentRefused(`${file} is password-protected; save an unprotected copy and ask again; nothing was sent`);
    throw new DocumentRefused(`${file} could not be read as a PDF (${name ?? "error"}); nothing was sent`);
  }
  const empty = pages.filter((p) => p === "").length;
  if (empty === pages.length) {
    throw new DocumentRefused(`${file} has no text layer (it looks like a scan or a picture); ChainAim cannot read text in images (there is no OCR), so nothing was sent`);
  }
  const text = pages
    .map((p, i) => (p === "" ? "" : `--- page ${i + 1} ---\n${p}`))
    .filter(Boolean)
    .join("\n\n");
  guard(text.length, maxChars, file);
  const warnings = empty > 0 ? [`${empty} of ${pages.length} pages have no text (possibly scanned) and were left out`] : [];
  return { text, detail: `${pages.length} page${pages.length === 1 ? "" : "s"}`, warnings };
}

async function readDocx(bytes: Buffer, file: string, maxChars: number): Promise<Omit<Extracted, "type">> {
  if (bytes.subarray(0, 2).toString("latin1") !== "PK") throw new DocumentRefused(`${file} is not a Word .docx file (it does not start like one); nothing was sent`);
  const mammoth = (await import("mammoth")).default;
  let raw: string;
  try {
    raw = (await mammoth.extractRawText({ buffer: bytes })).value;
  } catch {
    throw new DocumentRefused(`${file} could not be read as a Word document; nothing was sent`);
  }
  const text = tidy(raw);
  if (text === "") throw new DocumentRefused(`${file} holds no text; nothing was sent`);
  guard(text.length, maxChars, file);
  return { text, detail: `${text.split("\n").filter(Boolean).length} lines`, warnings: [] };
}

async function readXlsx(bytes: Buffer, file: string, options: ExtractOptions, maxChars: number): Promise<Omit<Extracted, "type">> {
  if (bytes.subarray(0, 2).toString("latin1") !== "PK") throw new DocumentRefused(`${file} is not an Excel .xlsx file (it does not start like one); nothing was sent`);
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    throw new DocumentRefused(`${file} could not be read as an Excel workbook; nothing was sent`);
  }
  const parts: string[] = [];
  let length = 0;
  let sheets = 0;
  let rowCount = 0;
  const warnings: string[] = [];
  let formulasWithoutResult = 0;
  workbook.eachSheet((sheet) => {
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = row.values as unknown[];
      const cells: string[] = [];
      // row.values is 1-based: index 0 is always empty.
      for (let c = 1; c < values.length; c++) {
        const v = values[c] as Record<string, unknown> | undefined;
        if (v && typeof v === "object" && ("formula" in v || "sharedFormula" in v) && (v.result === undefined || v.result === null)) formulasWithoutResult++;
        cells.push(cellText(values[c]));
      }
      rows.push(cells);
    });
    const body = renderTable(rows, options);
    if (body === "") return;
    sheets++;
    rowCount += rows.length - ((options.tableHeader ?? "first-row") === "first-row" ? 1 : 0);
    const part = `--- sheet ${sheets}: ${sheet.name} ---\n${body}`;
    length += part.length + 2;
    guard(length, maxChars, file);
    parts.push(part);
  });
  if (parts.length === 0) throw new DocumentRefused(`${file} holds no cell values; nothing was sent`);
  if (formulasWithoutResult > 0) warnings.push(`${formulasWithoutResult} formula cell(s) had no saved result and were left empty (open and save the file in Excel to keep them)`);
  return { text: parts.join("\n\n"), detail: `${sheets} sheet${sheets === 1 ? "" : "s"}, ${rowCount} row${rowCount === 1 ? "" : "s"}`, warnings };
}

function readCsv(bytes: Buffer, file: string, options: ExtractOptions, maxChars: number): Omit<Extracted, "type"> {
  let rows: string[][];
  try {
    rows = parseCsv(bytes.toString("utf8"), options.csvDelimiter ?? ",");
  } catch (e) {
    throw new DocumentRefused(`${file} could not be read as CSV (${(e as Error).message}); nothing was sent`);
  }
  const text = renderTable(rows, options);
  if (text === "") throw new DocumentRefused(`${file} holds no values; nothing was sent`);
  guard(text.length, maxChars, file);
  const dataRows = rows.filter((r) => r.some((c) => c.trim() !== "")).length - ((options.tableHeader ?? "first-row") === "first-row" ? 1 : 0);
  return { text, detail: `${Math.max(0, dataRows)} row${dataRows === 1 ? "" : "s"}`, warnings: [] };
}

/**
 * Read a document on this machine and give back its text. Refused
 * (DocumentRefused, nothing sent) for a type that is not read, a file that is
 * not what its extension says, a PDF with no text layer, an empty document, or
 * one past the size limits. The text still has every personal value in it:
 * the caller masks it before anything leaves this machine.
 */
export async function extractDocument(path: string, options: ExtractOptions = {}): Promise<Extracted> {
  const types = options.types ?? DOC_TYPES;
  const refusal = refusalFor(path, types);
  if (refusal) throw new DocumentRefused(refusal);
  const type = documentType(path)!;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  let size: number;
  try {
    size = statSync(path).size;
  } catch (e) {
    throw new DocumentRefused(`cannot read ${path}: ${(e as Error).message}`);
  }
  if (size > maxBytes) throw new DocumentRefused(`${path} is ${size} bytes; the most read is ${maxBytes} (--max-doc-mb); nothing was sent`);
  const bytes = readFileSync(path);
  let out: Omit<Extracted, "type">;
  switch (type) {
    case "txt":
    case "md": {
      const text = bytes.toString("utf8").replace(/^﻿/, "");
      if (text.trim() === "") throw new DocumentRefused(`${path} is empty`);
      guard(text.length, maxChars, path);
      out = { text, detail: `${text.length} characters`, warnings: [] };
      break;
    }
    case "pdf":
      out = await readPdf(bytes, path, maxChars);
      break;
    case "docx":
      out = await readDocx(bytes, path, maxChars);
      break;
    case "xlsx":
      out = await readXlsx(bytes, path, options, maxChars);
      break;
    case "csv":
      out = readCsv(bytes, path, options, maxChars);
      break;
  }
  return { type, ...out };
}
