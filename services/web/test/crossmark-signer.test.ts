import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CANCELLED, NOT_SIGNED, crossmarkSigner, type SignReply, type XrplTransaction } from "../src/crossmark-signer.ts";

const TX: XrplTransaction = { TransactionType: "Payment", Account: "rBuyer", Destination: "rPayTo", Sequence: 7 };
const reply = (data: unknown): SignReply => ({ response: { data } }) as SignReply;

function fakeCrossmark(answer: (tx: XrplTransaction) => SignReply | Promise<SignReply>) {
  const seen: XrplTransaction[] = [];
  return { seen, signAndWait: async (tx: XrplTransaction) => (seen.push(tx), answer(tx)) };
}

describe("crossmarkSigner (ARCH-016)", () => {
  it("ARCH-016 keeps the address", () => {
    assert.equal(crossmarkSigner("rADDR", fakeCrossmark(() => reply({})).signAndWait).classicAddress, "rADDR");
  });

  it("ARCH-016 hands Crossmark the transaction exactly as it was prepared", async () => {
    const crossmark = fakeCrossmark(() => reply({ txBlob: "12AB" }));
    await crossmarkSigner("rADDR", crossmark.signAndWait).sign(TX);
    assert.deepEqual(crossmark.seen, [TX]);
  });

  it("ARCH-016 returns the signed transaction as upper-case hex", async () => {
    const crossmark = fakeCrossmark(() => reply({ txBlob: "12ab00ff", meta: { isRejected: false, isSigned: true } }));
    assert.deepEqual(await crossmarkSigner("rADDR", crossmark.signAndWait).sign(TX), { signedTxBlob: "12AB00FF" });
  });

  it("ARCH-016 turns a rejected request into the cancelled message", async () => {
    const crossmark = fakeCrossmark(() => reply({ txBlob: "", meta: { isRejected: true } }));
    await assert.rejects(crossmarkSigner("rADDR", crossmark.signAndWait).sign(TX), { message: CANCELLED });
  });

  it("ARCH-016 passes any other Crossmark error on", async () => {
    const crossmark = fakeCrossmark(() => Promise.reject(new Error("boom")));
    await assert.rejects(crossmarkSigner("rADDR", crossmark.signAndWait).sign(TX), /boom/);
  });

  it("ARCH-016 fails clearly when Crossmark returns no signed transaction", async () => {
    for (const data of [undefined, {}, { txBlob: "" }, { txBlob: 12 }, { txBlob: "not hex" }, { txBlob: "ABC" }]) {
      const crossmark = fakeCrossmark(() => reply(data));
      await assert.rejects(crossmarkSigner("rADDR", crossmark.signAndWait).sign(TX), { message: NOT_SIGNED });
    }
    assert.equal(NOT_SIGNED, "Crossmark did not sign the payment. Nothing was paid.");
  });
});
