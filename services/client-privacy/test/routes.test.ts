import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BadRequest, postExtract, postMask, postRestore, postScan, type Settings } from "../src/routes.ts";

const settings: Settings = { names: true, extract: {} };

/** Synthetic throughout: invented names and the standard test card number. */
const SAMPLE = [
  "Patient: Meera Thalavan",
  "Phone: +91 98765 43210",
  "Card: 4111 1111 1111 1111",
].join("\n");

test("mask replaces values and hands back a map", () => {
  const r = postMask({ text: SAMPLE }, settings);
  assert.ok(!r.masked.includes("Meera Thalavan"), "the name must not survive masking");
  assert.ok(!r.masked.includes("98765 43210"), "the phone must not survive masking");
  assert.ok(Object.keys(r.map).length > 0, "a restore map must be returned");
  assert.ok(r.masked.includes("[CARD REMOVED]"), "a card is removed, not placeheld");
  assert.equal(r.cardsRemoved, 1);
});

test("a card number is never restorable", () => {
  const masked = postMask({ text: SAMPLE }, settings);
  assert.ok(
    !Object.values(masked.map).some((v) => v.replace(/\s/g, "").includes("4111111111111111")),
    "the card number must not be in the map",
  );
});

test("mask then restore is a round trip", () => {
  const masked = postMask({ text: SAMPLE }, settings);
  const back = postRestore({ text: masked.masked, map: masked.map });
  assert.ok(back.text.includes("Meera Thalavan"), "the name comes back on this computer");
  assert.equal(back.unresolved, 0);
});

test("names: false leaves labelled names alone", () => {
  const withNames = postMask({ text: SAMPLE, names: true }, settings);
  const without = postMask({ text: SAMPLE, names: false }, settings);
  assert.ok(without.masked.includes("Meera Thalavan"), "with names off the name stays");
  assert.ok(!withNames.masked.includes("Meera Thalavan"));
});

test("the service default for names applies when the body omits it", () => {
  const off = postMask({ text: SAMPLE }, { ...settings, names: false });
  assert.ok(off.masked.includes("Meera Thalavan"));
});

test("scan reports types, offsets and counts but no values", () => {
  const r = postScan({ text: SAMPLE }, settings);
  assert.ok(r.total > 0);
  const serialized = JSON.stringify(r);
  assert.ok(!serialized.includes("Meera"), "scan output must carry no value");
  assert.ok(!serialized.includes("98765"), "scan output must carry no value");
  for (const f of r.found) {
    assert.equal(typeof f.type, "string");
    assert.ok(Number.isInteger(f.start) && f.start >= 0);
    assert.ok(f.end > f.start);
  }
  assert.equal(
    Object.values(r.counts).reduce((a, b) => a + b, 0),
    r.total,
  );
});

test("restore leaves an unknown placeholder alone and counts it", () => {
  const r = postRestore({ text: "see <C_PERSON_9>", map: {} });
  assert.ok(r.text.includes("<C_PERSON_9>"));
  assert.equal(r.unresolved, 1);
});

test("a server-side placeholder is not touched by restore", () => {
  // <DATE_OF_BIRTH_1> is the gateway's own, not this computer's: it has no map entry.
  const r = postRestore({ text: "dob <DATE_OF_BIRTH_1>", map: { "<C_PERSON_1>": "Meera Thalavan" } });
  assert.ok(r.text.includes("<DATE_OF_BIRTH_1>"));
});

test("bad bodies are refused, not guessed at", () => {
  assert.throws(() => postMask("not an object", settings), BadRequest);
  assert.throws(() => postMask([], settings), BadRequest);
  assert.throws(() => postMask({}, settings), BadRequest);
  assert.throws(() => postMask({ text: 42 }, settings), BadRequest);
  assert.throws(() => postMask({ text: "x", names: "yes" }, settings), BadRequest);
  assert.throws(() => postRestore({ text: "x" }), BadRequest);
  assert.throws(() => postRestore({ text: "x", map: [] }), BadRequest);
  assert.throws(() => postRestore({ text: "x", map: { a: 1 } }), BadRequest);
  assert.throws(() => postRestore({ text: "x", map: {}, lenient: "yes" }), BadRequest);
});

test("extract reads a csv from disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "client-privacy-"));
  const file = join(dir, "patients.csv");
  writeFileSync(file, "Patient name,Diagnosis\nMeera Thalavan,Type 2 diabetes\n", "utf8");
  const r = await postExtract({ file }, settings);
  assert.equal(r.type, "csv");
  assert.ok(r.text.includes("Meera Thalavan"), "extract reads on this computer, it does not mask");
  assert.equal(typeof r.detail, "string");
});

test("extract refuses a path that is not a document", async () => {
  await assert.rejects(() => postExtract({ file: "nope.exe" }, settings));
  await assert.rejects(() => postExtract({}, settings), BadRequest);
  await assert.rejects(() => postExtract({ file: "" }, settings), BadRequest);
});

test("extract honours a per-request type allowlist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "client-privacy-"));
  const file = join(dir, "notes.txt");
  writeFileSync(file, "hello", "utf8");
  await assert.rejects(() => postExtract({ file, types: "csv" }, settings), "txt is not allowed when only csv is");
  const ok = await postExtract({ file, types: "txt,csv" }, settings);
  assert.equal(ok.type, "txt");
});

test("the extract pipeline feeds mask", async () => {
  const dir = mkdtempSync(join(tmpdir(), "client-privacy-"));
  const file = join(dir, "note.txt");
  writeFileSync(file, SAMPLE, "utf8");
  const read = await postExtract({ file }, settings);
  const masked = postMask({ text: read.text }, settings);
  assert.ok(!masked.masked.includes("Meera Thalavan"));
  const back = postRestore({ text: masked.masked, map: masked.map });
  assert.ok(back.text.includes("Meera Thalavan"));
});
