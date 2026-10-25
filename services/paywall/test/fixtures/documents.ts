/**
 * F3 test documents, built at test time so no binary files are kept in the
 * repository and no document library is needed besides the ones under test.
 * Every name, number and address in them is synthetic.
 *
 *   makePdf     a minimal PDF 1.4: one Helvetica text line per string, a page
 *               per array; an empty array gives a page with no text (a scan)
 *   makeDocx    a minimal Word package (its three required parts), zipped
 *               here with Node's zlib (stored, CRC from zlib.crc32)
 *   makeXlsx    a workbook written by exceljs itself
 */
import { crc32 } from "node:zlib";

/** A PDF whose pages hold the given lines, top to bottom. */
export function makePdf(pages: readonly (readonly string[])[]): Buffer {
  const esc = (s: string): string => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const objects: string[] = [];
  const add = (body: string): number => objects.push(body);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(""); // the page tree, filled in once the pages exist
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const kids: number[] = [];
  for (const lines of pages) {
    const ops = lines.map((line, i) => `BT /F1 12 Tf 72 ${800 - i * 20} Td (${esc(line)}) Tj ET`).join("\n");
    const content = add(`<< /Length ${Buffer.byteLength(ops, "latin1")} >>\nstream\n${ops}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A zip archive of the given files, stored (no compression). */
function zip(files: Readonly<Record<string, string>>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "utf8");
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += header.length + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

/** A Word .docx with the given paragraphs, then a table of the given rows. */
export function makeDocx(paragraphs: readonly string[], table: readonly (readonly string[])[] = []): Buffer {
  const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const p = (t: string): string => `<w:p><w:r><w:t xml:space="preserve">${xml(t)}</w:t></w:r></w:p>`;
  const rows = table.map((r) => `<w:tr>${r.map((c) => `<w:tc>${p(c)}</w:tc>`).join("")}</w:tr>`).join("");
  const body = paragraphs.map(p).join("") + (rows ? `<w:tbl>${rows}</w:tbl>` : "");
  return zip({
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  });
}

/**
 * The patients workbook: a "Patients" sheet with a header row, real dates and
 * 12-digit numbers, and a key/value "Notes" sheet whose first row is data, with
 * a formula that has no saved result.
 */
export async function makeXlsx(): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const patients = wb.addWorksheet("Patients");
  patients.addRow(["Name", "Date of birth", "Account", "Diagnosis"]);
  patients.addRow(["Ravi Kumar", new Date(Date.UTC(1975, 5, 2)), 123456789012, "Type 2 diabetes"]);
  patients.addRow(["Lakshmi Iyer", new Date(Date.UTC(1961, 2, 14)), 987654321098, "Hypertension"]);
  const notes = wb.addWorksheet("Notes");
  notes.addRow(["Contact", "ravi.kumar@example.com"]);
  notes.addRow(["Formula", { formula: "1+1" }]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
