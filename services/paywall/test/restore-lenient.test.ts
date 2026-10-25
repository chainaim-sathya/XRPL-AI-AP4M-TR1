/**
 * R1, client side (scripts/client-mask.ts restore): placeholders the model rewrote are restored,
 * anchored to this computer's map. The strings are the ones local/qwen2.5-3b returned in a real
 * paid run (2026-10-24, transaction 2FCF14E9...180B); the values here are synthetic.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { restore } from "../scripts/client-mask.ts";

const MAP = { "<C_PERSON_1>": "Alice Example", "<C_PERSON_2>": "Bea Example", "<C_EMAIL_ADDRESS_1>": "alice@example.test", "<C_IN_BANK_ACCOUNT_1>": "000111222" };

describe("client lenient restore (the real run's strings)", () => {
  it("a name the model wrote without brackets and without the C_ prefix", () => {
    assert.deepEqual(restore("a person named Person_1, who probably works", MAP), { text: "a person named Alice Example, who probably works", unresolved: 0 });
  });
  it("an e-mail placeholder without brackets", () => {
    assert.equal(restore("the email address C_EMAIL_ADDRESS_1.", MAP).text, "the email address alice@example.test.");
  });
  it("a bank account inside the model's parentheses: the parentheses stay", () => {
    assert.equal(restore("Supplier Account No. (C_IN_BANK_ACCOUNT_1):", MAP).text, "Supplier Account No. (000111222):");
  });
  it("a name twice, once inside an opening parenthesis", () => {
    assert.equal(restore("named Person_2 (Person_2, likely the name", MAP).text, "named Bea Example (Bea Example, likely the name");
  });
});

describe("client lenient restore: what it must leave alone", () => {
  it("the server's own bracketed <PERSON_1> is not taken for the client's, and is not counted", () => {
    assert.deepEqual(restore("<PERSON_1> is the server's", MAP), { text: "<PERSON_1> is the server's", unresolved: 0 });
  });
  it("prefix-dropping can be switched off (when the server kept its own placeholders)", () => {
    assert.equal(restore("Person_1 and C_PERSON_1", MAP, { dropPrefix: false }).text, "Person_1 and Alice Example");
  });
  it("strict mode restores only <C_...> in brackets, as before", () => {
    assert.equal(restore("Person_1, C_PERSON_1 and < c_person_1 >", MAP, { lenient: false }).text, "Person_1, C_PERSON_1 and Alice Example");
  });
  it("never inside a longer token: PERSON_10, XPERSON_1, PERSON_1X stay", () => {
    assert.equal(restore("PERSON_10 XPERSON_1 PERSON_1X", MAP).text, "PERSON_10 XPERSON_1 PERSON_1X");
  });
  it("counts a lookalike of a known type that is not in the map (bare or bracketed), and leaves it", () => {
    assert.deepEqual(restore("ask Person_9 and <C_PERSON_9>", MAP), { text: "ask Person_9 and <C_PERSON_9>", unresolved: 2 });
  });
  it("does not count words of unknown types", () => {
    assert.equal(restore("invoice INV_5518, PO_7731", MAP).unresolved, 0);
  });
  it("drops [] and {} around a known name, like angle brackets", () => {
    assert.equal(restore("[C_PERSON_1] {person_2}", MAP).text, "Alice Example Bea Example");
  });
});
