/** scripts/buy-rlusd-core.ts: argument checks, quote choice, the spending cap, the transaction shape and the outcome. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Wallet } from "xrpl";
import { BuyRefused, bestXrpQuote, buyOutcome, buyPayment, parseBuyArgs, sendMaxDrops } from "../scripts/buy-rlusd-core.ts";

const TOKEN = { currency: "524C555344000000000000000000000000000000", issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" };
// A sample address generated for each run: tests never reference a real wallet.
const ME = Wallet.generate().classicAddress;

describe("parseBuyArgs", () => {
  it("accepts positive decimals and a slippage from 0 to 50", () => {
    assert.deepEqual(parseBuyArgs({ amount: "1", "max-xrp": "5", "slippage-pct": "2" }), { amount: "1", maxXrp: "5", slippagePct: 2 });
    assert.equal(parseBuyArgs({ amount: "0.5", "max-xrp": "2.25", "slippage-pct": "0" }).slippagePct, 0);
  });
  it("refuses a missing --max-xrp, zero, negative, non-numeric and an out-of-range slippage", () => {
    assert.throws(() => parseBuyArgs({ amount: "1", "slippage-pct": "2" }), BuyRefused);
    assert.throws(() => parseBuyArgs({ amount: "0", "max-xrp": "5", "slippage-pct": "2" }), BuyRefused);
    assert.throws(() => parseBuyArgs({ amount: "-1", "max-xrp": "5", "slippage-pct": "2" }), BuyRefused);
    assert.throws(() => parseBuyArgs({ amount: "1e3", "max-xrp": "5", "slippage-pct": "2" }), BuyRefused);
    assert.throws(() => parseBuyArgs({ amount: "1", "max-xrp": "5", "slippage-pct": "51" }), BuyRefused);
  });
});

describe("bestXrpQuote", () => {
  it("picks the cheapest XRP source and keeps its paths; ignores token sources", () => {
    const q = bestXrpQuote({ alternatives: [
      { source_amount: "2100000", paths_computed: [[{ currency: "X" }]] },
      { source_amount: { currency: "USD", issuer: "r", value: "1" } },
      { source_amount: "2000000", paths_computed: [] },
    ] });
    assert.deepEqual(q, { drops: 2000000n, paths: [] });
  });
  it("returns undefined when there is no XRP route", () => {
    assert.equal(bestXrpQuote({ alternatives: [] }), undefined);
    assert.equal(bestXrpQuote({}), undefined);
  });
});

describe("sendMaxDrops", () => {
  it("adds the slippage allowance to the quote", () => {
    assert.equal(sendMaxDrops(2_000_000n, "5", 2), 2_040_000n);
  });
  it("never goes above --max-xrp", () => {
    assert.equal(sendMaxDrops(4_950_000n, "5", 2), 5_000_000n);
  });
  it("refuses when the quote alone is above --max-xrp", () => {
    assert.throws(() => sendMaxDrops(5_000_001n, "5", 2), /above --max-xrp 5/);
  });
});

describe("buyPayment", () => {
  it("is a self-payment for the exact RLUSD amount with an XRP SendMax and no partial-payment flag", () => {
    const tx = buyPayment(ME, TOKEN, "1", 2_040_000n, []);
    assert.deepEqual(tx, { TransactionType: "Payment", Account: ME, Destination: ME, Amount: { ...TOKEN, value: "1" }, SendMax: "2040000" });
    assert.equal("Flags" in tx, false);
  });
  it("carries the server's paths when it found some", () => {
    assert.deepEqual(buyPayment(ME, TOKEN, "1", 1n, [[{ currency: "XRP" }]]).Paths, [[{ currency: "XRP" }]]);
  });
});

describe("buyOutcome", () => {
  it("reads the result and the RLUSD delivered", () => {
    assert.deepEqual(buyOutcome({ TransactionResult: "tesSUCCESS", delivered_amount: { ...TOKEN, value: "1" } }, TOKEN), { result: "tesSUCCESS", delivered: "1" });
  });
  it("does not report another token as delivered, and survives missing metadata", () => {
    assert.deepEqual(buyOutcome({ TransactionResult: "tecPATH_PARTIAL", delivered_amount: { currency: "USD", issuer: "r", value: "1" } }, TOKEN), { result: "tecPATH_PARTIAL" });
    assert.deepEqual(buyOutcome(undefined, TOKEN), { result: "unknown" });
  });
});
