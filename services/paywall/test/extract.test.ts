/**
 * F3: reading PDF, Word, Excel and CSV documents on the user's machine before
 * masking (scripts/extract.ts). Real files built at test time
 * (test/fixtures/documents.ts), synthetic values only; no network.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { cellText, DocumentRefused, extractDocument, parseCsv, parseDocTypes, refusalFor, renderTable } from "../scripts/extract.ts";
import { makeDocx, makePdf, makeXlsx } from "./fixtures/documents.ts";

const NOTE_PDF = makePdf([
  ["Discharge summary", "Patient: Mr. Ravi Kumar   MRN: 991122", "Email: ravi.kumar@example.com   Phone: +91 98765 43210"],
  ["Follow-up: diabetes clinic in 2 weeks; HbA1c in 3 months."],
]);
/** A page with no text at all, as a scanned page is to a text extractor. */
const SCAN_PDF = makePdf([[]]);
const LETTER_DOCX = makeDocx(
  ["Referral letter", "Dear Dr. Anita Sharma,", "I am referring Mrs. Lakshmi Iyer (DOB 14/03/1961), account no. 123456789012, for review."],
  [["Name", "Lakshmi Iyer"], ["Phone", "+91 91234 56789"]],
);
let PATIENTS_XLSX: Buffer;

let dir: string;
const file = (name: string, content: string | Buffer): string => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

describe("F3 document extraction", () => {
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "chainaim-f3-"));
    PATIENTS_XLSX = await makeXlsx();
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("F3 pdf: every page's text, with page markers; the values are there for the masker to find", async () => {
    const r = await extractDocument(file("note.pdf", NOTE_PDF));
    assert.equal(r.type, "pdf");
    assert.equal(r.detail, "2 pages");
    assert.match(r.text, /--- page 1 ---\nDischarge summary/);
    assert.match(r.text, /Mr\. Ravi Kumar/);
    assert.match(r.text, /MRN: 991122/);
    assert.match(r.text, /--- page 2 ---\nFollow-up: diabetes clinic in 2 weeks/);
    assert.deepEqual(r.warnings, []);
  });

  it("F3 pdf: a scan with no text layer is refused, says there is no OCR, and names no value", async () => {
    await assert.rejects(extractDocument(file("scan.pdf", SCAN_PDF)), (e: Error) => {
      assert.ok(e instanceof DocumentRefused);
      assert.match(e.message, /no text layer/);
      assert.match(e.message, /no OCR/);
      assert.match(e.message, /nothing was sent/);
      return true;
    });
  });

  it("F3 pdf: a file that only claims to be a PDF is refused", async () => {
    await assert.rejects(extractDocument(file("fake.pdf", "Patient: Ravi Kumar")), /is not a PDF file/);
  });

  it("F3 docx: the letter's text, table cells included", async () => {
    const r = await extractDocument(file("letter.docx", LETTER_DOCX));
    assert.equal(r.type, "docx");
    assert.match(r.text, /Dear Dr\. Anita Sharma/);
    assert.match(r.text, /Mrs\. Lakshmi Iyer \(DOB 14\/03\/1961\), account no\. 123456789012/);
    assert.match(r.text, /\+91 91234 56789/);
    assert.doesNotMatch(r.text, /\n{3,}/, "blank lines collapsed");
  });

  it("F3 xlsx: labelled rows keep each header beside its value, dates as YYYY-MM-DD, every sheet", async () => {
    const r = await extractDocument(file("patients.xlsx", PATIENTS_XLSX));
    assert.equal(r.type, "xlsx");
    assert.equal(r.detail, "2 sheets, 3 rows");
    assert.match(r.text, /--- sheet 1: Patients ---/);
    // The gateway's DOB and bank-account detectors need "birth" / "account" next to the value.
    assert.match(r.text, /Name: Ravi Kumar\nDate of birth: 1975-06-02\nAccount: 123456789012\nDiagnosis: Type 2 diabetes/);
    assert.match(r.text, /Date of birth: 1961-03-14/);
    assert.match(r.text, /--- sheet 2: Notes ---/);
    // A key/value sheet has data in its first row: it is written out, never dropped as "just a header".
    assert.match(r.text, /Columns: Contact \| ravi\.kumar@example\.com/);
    assert.doesNotMatch(r.text, /1\+1/, "a formula's text is never sent");
    assert.equal(r.warnings.length, 1, "the formula without a saved result is reported");
    assert.match(r.warnings[0], /1 formula cell/);
  });

  it("F3 xlsx grid: one line per row, smaller, with the header line first", async () => {
    const r = await extractDocument(file("patients-grid.xlsx", PATIENTS_XLSX), { tableFormat: "grid" });
    assert.match(r.text, /Name \| Date of birth \| Account \| Diagnosis\nRavi Kumar \| 1975-06-02 \| 123456789012 \| Type 2 diabetes/);
  });

  it("F3 csv: quoted commas and line breaks are one field; rows are labelled", async () => {
    const csv = 'Name,Account,Address,Amount\r\n"Kumar, Ravi",123456789012,"12 MG Road\nBengaluru",1500.00\r\nLakshmi Iyer,987654321098,"4 Beach Rd",-200\r\n';
    const r = await extractDocument(file("statement.csv", csv));
    assert.equal(r.type, "csv");
    assert.equal(r.detail, "2 rows");
    assert.equal(
      r.text,
      "Columns: Name | Account | Address | Amount\n\nName: Kumar, Ravi\nAccount: 123456789012\nAddress: 12 MG Road Bengaluru\nAmount: 1500.00\n\nName: Lakshmi Iyer\nAccount: 987654321098\nAddress: 4 Beach Rd\nAmount: -200",
    );
  });

  it("F3 csv: an unclosed quote is refused rather than guessed at; a byte-order mark is dropped", async () => {
    await assert.rejects(extractDocument(file("broken.csv", 'Name,Note\nRavi,"never closed\n')), /could not be read as CSV/);
    assert.deepEqual(parseCsv("﻿a;b\n1;2", ";"), [["a", "b"], ["1", "2"]]);
  });

  it("F3 images and old Office files are refused with what to do instead; other types name the accepted ones", () => {
    assert.match(refusalFor("photo.JPG")!, /is an image; ChainAim cannot read text in images \(there is no OCR\)/);
    assert.match(refusalFor("old.doc")!, /save it as \.docx/);
    assert.match(refusalFor("old.xls")!, /save it as \.xlsx/);
    assert.match(refusalFor("slides.pptx")!, /cannot be read; use \.txt, \.md, \.pdf, \.docx, \.xlsx, \.csv/);
    assert.equal(refusalFor("note.pdf"), undefined);
  });

  it("F3 --doc-types switches types off, and a switched-off type is refused", async () => {
    assert.deepEqual(parseDocTypes("txt, PDF,txt"), ["txt", "pdf"]);
    assert.deepEqual(parseDocTypes("all"), ["txt", "md", "pdf", "docx", "xlsx", "csv"]);
    assert.throws(() => parseDocTypes("txt,png"), /unknown document type png/);
    await assert.rejects(extractDocument(file("off.csv", "a,b\n1,2"), { types: ["txt", "md"] }), /\.csv files are switched off here/);
  });

  it("F3 size limits: too many bytes or too much text is refused, nothing read past the limit", async () => {
    await assert.rejects(extractDocument(file("big.txt", "x".repeat(2000)), { maxBytes: 1000 }), /the most read is 1000/);
    await assert.rejects(extractDocument(file("long.txt", "Name: Ravi Kumar\n".repeat(100)), { maxChars: 500 }), /more than 500 characters/);
  });

  it("F3 txt and md: read as before; an empty file is refused", async () => {
    const r = await extractDocument(file("note.md", "﻿# Note\nPatient Ravi Kumar"));
    assert.equal(r.text, "# Note\nPatient Ravi Kumar");
    await assert.rejects(extractDocument(file("empty.txt", "  \n")), /is empty/);
  });

  it("F3 cellText: formulas give their result only, hyperlinks their text, errors nothing; big integers stay whole", () => {
    assert.equal(cellText({ formula: "A1*2", result: 42 }), "42");
    assert.equal(cellText({ sharedFormula: "B1", result: new Date(Date.UTC(1980, 0, 5)) }), "1980-01-05");
    assert.equal(cellText({ formula: "VLOOKUP(\"Ravi Kumar\",A:B,2)" }), "", "no result: empty, never the formula");
    assert.equal(cellText({ text: "Ravi Kumar", hyperlink: "mailto:ravi@example.com" }), "Ravi Kumar");
    assert.equal(cellText({ richText: [{ text: "Ravi " }, { text: "Kumar" }] }), "Ravi Kumar");
    assert.equal(cellText({ error: "#N/A" }), "");
    assert.equal(cellText(123456789012), "123456789012");
    assert.equal(cellText(new Date(Date.UTC(2026, 9, 24, 9, 30))), "2026-10-24 09:30");
  });

  it("F3 every cell of a table reaches the text, header row included (nothing for the masker to miss)", async () => {
    const r = await extractDocument(file("every-cell.xlsx", PATIENTS_XLSX));
    for (const v of ["Ravi Kumar", "1975-06-02", "123456789012", "Lakshmi Iyer", "1961-03-14", "987654321098", "ravi.kumar@example.com", "Contact", "Formula"]) {
      assert.ok(r.text.includes(v), `${v} is missing from the extracted text`);
    }
  });

  it("F3 renderTable: a header-less table gets Column A, B ...; empty cells and rows are skipped", () => {
    const text = renderTable([["Ravi Kumar", "", "123456789012"], ["", "", ""], ["Lakshmi Iyer", "x", ""]], { tableHeader: "none" });
    assert.equal(text, "Column A: Ravi Kumar\nColumn C: 123456789012\n\nColumn A: Lakshmi Iyer\nColumn B: x");
  });
});
