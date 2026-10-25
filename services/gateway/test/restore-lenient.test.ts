/**
 * R1: placeholders a model rewrote are still restored (privacy/restore.ts, lenient mode),
 * anchored to the map, and what still looks like one is counted. Cases come from a real
 * run where local/qwen2.5-3b dropped brackets, used parentheses and changed case.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasPlaceholder, PLACEHOLDER_INSTRUCTION, restoreCompletion, restoreText, type RestoreStats } from "../src/privacy/restore.ts";

const MAP = { "<PERSON_1>": "Jane Roe", "<PERSON_2>": "Raj Patel", "<EMAIL_ADDRESS_1>": "jane@example.test", "<BANK_ACCOUNT_1>": "12-3456-7890123-00" };
const run = (text: string, lenient = true, json = false): { text: string; stats: RestoreStats } => {
  const stats: RestoreStats = { unresolved: 0 };
  return { text: restoreText(text, MAP, stats, json, { lenient }), stats };
};

describe("lenient restore", () => {
  it("restores a placeholder written without brackets, in any case", () => {
    const r = run("a person named Person_1, who works with EMAIL_ADDRESS_1.");
    assert.equal(r.text, "a person named Jane Roe, who works with jane@example.test.");
    assert.equal(r.stats.unresolved, 0);
    assert.equal(r.stats.lenient, 2);
  });

  it("keeps the model's parentheses as prose and restores inside them", () => {
    assert.equal(run("Account No. (BANK_ACCOUNT_1): named Person_2 (Person_2, likely").text, "Account No. (12-3456-7890123-00): named Raj Patel (Raj Patel, likely");
  });

  it("restores inside square and curly brackets and drops them, as it drops angle brackets", () => {
    assert.equal(run("[PERSON_1] and {person_2} and < PERSON_1 >").text, "Jane Roe and Raj Patel and Jane Roe");
  });

  it("never matches a longer number or a name inside a word: PERSON_10, XPERSON_1, PERSON_1X, C_PERSON_1 stay", () => {
    const r = run("PERSON_10 XPERSON_1 PERSON_1X C_PERSON_1");
    assert.equal(r.text, "PERSON_10 XPERSON_1 PERSON_1X C_PERSON_1");
  });

  it("counts a bare lookalike of a known type that is not in the map, and leaves it", () => {
    const r = run("ask Person_9 about it");
    assert.equal(r.text, "ask Person_9 about it");
    assert.equal(r.stats.unresolved, 1);
  });

  it("does not count words of unknown types (INV_5518 is an invoice, not a placeholder)", () => {
    assert.equal(run("invoice INV_5518 and PO_7731").stats.unresolved, 0);
  });

  it("still counts an unknown bracketed server placeholder; the client's <C_...> is left alone and not counted", () => {
    const r = run("Hi <PERSON_9> and <C_PERSON_1>");
    assert.equal(r.text, "Hi <PERSON_9> and <C_PERSON_1>");
    assert.equal(r.stats.unresolved, 1);
  });

  it("strict mode (lenient off) restores only the bracketed form, as before", () => {
    const r = run("Person_1 and <person_1>", false);
    assert.equal(r.text, "Person_1 and Jane Roe");
    assert.equal(r.stats.lenient ?? 0, 0);
  });

  it("keeps tool-call arguments valid JSON when restoring bare placeholders", () => {
    const map = { "<PERSON_1>": 'Jane "JR" Roe' };
    const stats: RestoreStats = { unresolved: 0 };
    const out = restoreText('{"who":"PERSON_1","why":"(person_1)"}', map, stats, true, { lenient: true });
    assert.deepEqual(JSON.parse(out), { who: 'Jane "JR" Roe', why: '(Jane "JR" Roe)' });
  });

  it("restoreCompletion is lenient by default and passes the option through", () => {
    const c = { choices: [{ message: { content: "for Person_1" } }] };
    restoreCompletion(c, MAP, { unresolved: 0 });
    assert.equal(c.choices[0].message.content, "for Jane Roe");
    const s = { choices: [{ message: { content: "for Person_1" } }] };
    restoreCompletion(s, MAP, { unresolved: 0 }, { lenient: false });
    assert.equal(s.choices[0].message.content, "for Person_1");
  });

  it("an empty map changes nothing and counts nothing bare", () => {
    const stats: RestoreStats = { unresolved: 0 };
    assert.equal(restoreText("Person_1 says hi", {}, stats, false, { lenient: true }), "Person_1 says hi");
    assert.equal(stats.unresolved, 0);
  });
});

describe("placeholder instruction helpers", () => {
  it("hasPlaceholder sees server and client placeholders and card removals", () => {
    assert.equal(hasPlaceholder("hi <PERSON_1>"), true);
    assert.equal(hasPlaceholder("hi < c_person_2 >"), true);
    assert.equal(hasPlaceholder("card [CARD REMOVED]"), true);
    assert.equal(hasPlaceholder("plain text, invoice INV_5518"), false);
  });
  it("the instruction names the angle-bracket form and asks for exact copies", () => {
    assert.match(PLACEHOLDER_INSTRUCTION, /<PERSON_1>/);
    assert.match(PLACEHOLDER_INSTRUCTION, /exactly/i);
  });
});

describe("the client's own placeholders", () => {
  it("leaves <C_...> alone and does not count them: the client restores those (E2E run 2026-10-24 01:32Z counted 3)", () => {
    const stats = { unresolved: 0 };
    const text = "Dear Ms. <C_PERSON_2>, account <C_IN_BANK_ACCOUNT_1>; again < c_person_2 >. Also <PERSON_1>.";
    assert.equal(restoreText(text, { "<PERSON_1>": "Jane Roe" }, stats), "Dear Ms. <C_PERSON_2>, account <C_IN_BANK_ACCOUNT_1>; again < c_person_2 >. Also Jane Roe.");
    assert.equal(stats.unresolved, 0);
  });
  it("still counts an unknown server placeholder", () => {
    const stats = { unresolved: 0 };
    restoreText("Hi <PERSON_9> and <C_PERSON_1>", { "<PERSON_1>": "Jane Roe" }, stats);
    assert.equal(stats.unresolved, 1);
  });
});
