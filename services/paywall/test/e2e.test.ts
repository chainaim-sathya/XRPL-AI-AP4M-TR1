/** scripts/e2e-core.ts: the paywall quote, exact balance changes, settlement detection and every verdict check. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Wallet } from "xrpl";
import { decodeQuote, E2ERefused, ledgerTxFrom, rlusdDelta, settledIn, verdict, type RunFacts } from "../scripts/e2e-core.ts";

// Sample addresses generated for each run: tests never reference a real wallet.
const B01 = Wallet.generate().classicAddress;
const SELLER = Wallet.generate().classicAddress;
const TX = "2FCF14E90D477714A2FC77B890A459EF86E580A99AF88B95A173EDAB9ABE180B";
const header = (offer: Record<string, unknown>) => Buffer.from(JSON.stringify({ x402Version: 2, accepts: [offer] })).toString("base64");
const OFFER = { scheme: "exact", network: "xrpl:1", amount: "0.01", asset: "524C555344000000000000000000000000000000", payTo: SELLER, extra: { issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" } };

/** The real run of 2026-10-24: BEFORE buyer 1 / seller 0.35, AFTER 0.99 / 0.36. */
const GOOD: RunFacts = {
  quote: decodeQuote(header(OFFER)),
  expectNetwork: "xrpl:1",
  status: 200,
  receipt: { success: true, transaction: TX, network: "xrpl:1", payer: B01 },
  buyer: B01,
  before: { buyerRlusd: "1", sellerRlusd: "0.35", buyerDrops: "87848606" },
  after: { buyerRlusd: "0.99", sellerRlusd: "0.36", buyerDrops: "87848596" },
  ledgerTx: { validated: true, result: "tesSUCCESS", account: B01, destination: SELLER, delivered: { currency: OFFER.asset, issuer: OFFER.extra.issuer, value: "0.01" }, feeDrops: "10" },
  bodyText: '{"messages":[{"role":"user","content":"Name: <C_PERSON_1>"}]}',
  originals: ["Alice Example"],
  clientUnresolved: 0,
  gatewayUnresolved: "0",
  answered: true,
};

describe("decodeQuote", () => {
  it("reads payTo, amount, network, asset and issuer", () => {
    assert.deepEqual(decodeQuote(header(OFFER)), { payTo: SELLER, amount: "0.01", network: "xrpl:1", asset: OFFER.asset, issuer: OFFER.extra.issuer });
  });
  it("refuses no header, a header that is not base64 JSON, and an offer missing fields", () => {
    assert.throws(() => decodeQuote(null), E2ERefused);
    assert.throws(() => decodeQuote("not-json"), E2ERefused);
    assert.throws(() => decodeQuote(header({ network: "xrpl:1" })), E2ERefused);
  });
});

describe("rlusdDelta and settledIn", () => {
  it("subtracts exactly, as decimals", () => {
    assert.equal(rlusdDelta("1", "0.99"), "-0.01");
    assert.equal(rlusdDelta("0.35", "0.36"), "+0.01");
    assert.equal(rlusdDelta("0.1", "0.3"), "+0.2");
    assert.equal(rlusdDelta(undefined, "0.01"), "+0.01");
  });
  it("detects the payment only when both sides moved by the price", () => {
    assert.equal(settledIn(GOOD.before, GOOD.after, "0.01"), true);
    assert.equal(settledIn(GOOD.before, GOOD.before, "0.01"), false);
    assert.equal(settledIn(GOOD.before, { buyerRlusd: "0.99", sellerRlusd: "0.35" }, "0.01"), false);
  });
});

describe("verdict", () => {
  const failing = (f: RunFacts) => verdict(f).filter((c) => !c.ok).map((c) => c.name);
  it("passes every check for the real run", () => {
    assert.deepEqual(failing(GOOD), []);
    assert.equal(verdict(GOOD).length, 10);
  });
  it("fails when an original value is in the request body (a leak)", () => {
    assert.deepEqual(failing({ ...GOOD, bodyText: '{"content":"Name: Alice Example"}' }), ["nothing personal left this computer"]);
  });
  it("fails when the seller did not receive the price, or the buyer paid a different amount", () => {
    assert.deepEqual(failing({ ...GOOD, after: { ...GOOD.after, buyerRlusd: "0.99", sellerRlusd: "0.35" } }), ["seller received the price"]);
    assert.deepEqual(failing({ ...GOOD, after: { ...GOOD.after, buyerRlusd: "0.98", sellerRlusd: "0.36" } }), ["buyer paid the price"]);
  });
  it("fails on no receipt, a failed receipt, another payer, a wrong network, no answer", () => {
    const { receipt: _receipt, ...noReceipt } = GOOD;
    assert.ok(failing(noReceipt as RunFacts).includes("payment settled"));
    assert.ok(failing({ ...GOOD, receipt: { ...GOOD.receipt!, success: false } }).includes("payment settled"));
    assert.deepEqual(failing({ ...GOOD, receipt: { ...GOOD.receipt!, payer: SELLER } }), ["payer is the buyer"]);
    assert.deepEqual(failing({ ...GOOD, quote: { ...GOOD.quote, network: "xrpl:0" } }), ["quote network"]);
    assert.deepEqual(failing({ ...GOOD, status: 503, answered: false }), ["HTTP 200 with an answer"]);
  });
  it("fails when a placeholder was not put back, here or at the gateway", () => {
    assert.deepEqual(failing({ ...GOOD, clientUnresolved: 2 }), ["every placeholder put back"]);
    assert.deepEqual(failing({ ...GOOD, gatewayUnresolved: "1" }), ["every placeholder put back"]);
  });
});

describe("ledgerTxFrom", () => {
  const meta = { TransactionResult: "tesSUCCESS", delivered_amount: { currency: OFFER.asset, issuer: OFFER.extra.issuer, value: "0.01" } };
  it("reads an api_version 2 answer (fields under tx_json)", () => {
    assert.deepEqual(ledgerTxFrom({ validated: true, meta, tx_json: { Account: B01, Destination: SELLER, Fee: "10" } }), GOOD.ledgerTx);
  });
  it("reads an api_version 1 answer (fields at the top)", () => {
    assert.deepEqual(ledgerTxFrom({ validated: true, meta, Account: B01, Destination: SELLER, Fee: "10" }), GOOD.ledgerTx);
  });
  it("marks an unvalidated or failed transaction, and an XRP delivery, as such", () => {
    assert.equal(ledgerTxFrom({ validated: false, meta, tx_json: { Account: B01, Destination: SELLER, Fee: "10" } }).validated, false);
    assert.equal(ledgerTxFrom({ validated: true, meta: { TransactionResult: "tecPATH_DRY" }, tx_json: { Account: B01, Destination: SELLER, Fee: "10" } }).result, "tecPATH_DRY");
    assert.equal(ledgerTxFrom({ validated: true, meta: { TransactionResult: "tesSUCCESS", delivered_amount: "10000" }, tx_json: { Account: B01, Destination: SELLER, Fee: "10" } }).delivered, undefined);
  });
});

describe("verdict: the payment as the ledger records it", () => {
  const failing = (f: RunFacts) => verdict(f).filter((c) => !c.ok).map((c) => c.name);
  const tx = GOOD.ledgerTx!;
  it("fails when the transaction is not found, not validated or not tesSUCCESS", () => {
    const { ledgerTx: _drop, ...noTx } = GOOD;
    assert.deepEqual(failing(noTx), ["payment on the ledger", "buyer's XRP change is the fee"]);
    assert.deepEqual(failing({ ...GOOD, ledgerTx: { ...tx, validated: false } }), ["payment on the ledger"]);
    assert.deepEqual(failing({ ...GOOD, ledgerTx: { ...tx, result: "tecPATH_PARTIAL" } }), ["payment on the ledger"]);
  });
  it("fails when it went to someone else, came from someone else, or delivered another amount or token", () => {
    assert.deepEqual(failing({ ...GOOD, ledgerTx: { ...tx, destination: B01 } }), ["payment on the ledger"]);
    assert.deepEqual(failing({ ...GOOD, ledgerTx: { ...tx, account: SELLER } }), ["payment on the ledger"]);
    assert.deepEqual(failing({ ...GOOD, ledgerTx: { ...tx, delivered: { ...tx.delivered!, value: "0.009" } } }), ["payment on the ledger"]);
    assert.deepEqual(failing({ ...GOOD, ledgerTx: { ...tx, delivered: { ...tx.delivered!, issuer: SELLER } } }), ["payment on the ledger"]);
  });
  it("accepts the same amount written differently (0.010)", () => {
    assert.deepEqual(failing({ ...GOOD, ledgerTx: { ...tx, delivered: { ...tx.delivered!, value: "0.010" } } }), []);
  });
  it("fails when the buyer's XRP fell by more or less than the fee", () => {
    assert.deepEqual(failing({ ...GOOD, after: { ...GOOD.after, buyerDrops: "87848586" } }), ["buyer's XRP change is the fee"]);
  });
});
