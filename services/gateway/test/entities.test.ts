/**
 * The extra ad-hoc patterns (privacy/entities.ts) against lines from the
 * sample bank statement. Presidio runs them in Python with IGNORECASE; this
 * runs the same regex text in JavaScript with the "i" flag, which agrees for
 * these patterns (no lookbehind, no Python-only syntax). Context-word scoring
 * is Presidio's and is not reproduced here: only whether a pattern matches.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXTRA_AD_HOC_RECOGNIZERS } from "../src/privacy/entities.ts";

function matches(group: keyof typeof EXTRA_AD_HOC_RECOGNIZERS, text: string, standalone = false): string[] {
  const out: string[] = [];
  for (const p of EXTRA_AD_HOC_RECOGNIZERS[group].patterns ?? []) {
    if (standalone && p.score < 0.4) continue;
    for (const m of text.matchAll(new RegExp(p.regex, "gi"))) if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

describe("extra patterns", () => {
  it("bank_account: the NZ format stands alone; other shapes are candidates that need a context word", () => {
    assert.deepEqual(matches("bank_account", "Account 12-3456-7890123-00 balance", true), ["12-3456-7890123-00"]);
    assert.ok(matches("bank_account", "acct 991200345678").includes("991200345678"));
    assert.ok(matches("bank_account", "BSB 062-000 12345678").includes("062-000 12345678"));
    assert.deepEqual(matches("bank_account", "paid 1,250.00 on 05/01/2024", true), []);
  });

  it("titled_name: title, initials, then one or two name words", () => {
    assert.deepEqual(matches("titled_name", "MR AB SAMPLEPERSON & MRS C SAMPLENAME"), ["MR AB SAMPLEPERSON", "MRS C SAMPLENAME"]);
    assert.ok(matches("titled_name", "Dr. Alan Grant prescribed")[0].startsWith("Dr. Alan Grant"));
    assert.deepEqual(matches("titled_name", "Use MS Excel"), []);
  });

  it("street_address: a house number and a street word", () => {
    assert.deepEqual(matches("street_address", "Post to 42 Rosewood Avenue, Wellington"), ["42 Rosewood Avenue"]);
    assert.deepEqual(matches("street_address", "15 MG Road, Bengaluru"), ["15 MG Road"]);
  });

  it("dob: date shapes, all needing a birth word, so transaction dates stay", () => {
    assert.ok(matches("dob", "Date of birth 14/03/1981").includes("14/03/1981"));
    assert.ok(matches("dob", "DOB: 3 March 1981").includes("3 March 1981"));
    assert.deepEqual(matches("dob", "Date of birth 14/03/1981", true), [], "no date pattern stands alone");
  });
});
