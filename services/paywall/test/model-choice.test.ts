/** H2 terminal path: the client may name a model (e.g. hosted/nemotron-nano-reasoning); the default stays chainaim/auto. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Wallet } from "xrpl";
import { AskRefused, prepareAsk } from "../scripts/private-ask-core.ts";
import { decodeQuote, verdict, type RunFacts } from "../scripts/e2e-core.ts";

const doc = "Name: Alice Example\nInvoice INV-5518 for 9,850 USD was paid twice.";

describe("prepareAsk model", () => {
  it("defaults to chainaim/auto (unchanged)", () => {
    assert.equal(JSON.parse(prepareAsk({ document: doc, endpoint: "chat" }).bodyText).model, "chainaim/auto");
  });
  it("sends the named model", () => {
    assert.equal(JSON.parse(prepareAsk({ document: doc, endpoint: "chat", model: "hosted/nemotron-nano-reasoning" }).bodyText).model, "hosted/nemotron-nano-reasoning");
  });
  it("refuses a model name that is not provider/name, before anything is sent", () => {
    for (const bad of ["", "nemotron", "a b/c", "x/y z"]) assert.throws(() => prepareAsk({ document: doc, endpoint: "chat", model: bad }), AskRefused);
  });
  it("ignores the model for scan and mask (no model there)", () => {
    assert.equal(JSON.parse(prepareAsk({ document: doc, endpoint: "scan", model: "hosted/x" }).bodyText).model, undefined);
  });
});

describe("verdict: served by the requested model", () => {
  const B = Wallet.generate().classicAddress;
  const S = Wallet.generate().classicAddress;
  const header = Buffer.from(JSON.stringify({ accepts: [{ scheme: "exact", network: "xrpl:1", amount: "0.01", asset: "524C555344000000000000000000000000000000", payTo: S, extra: { issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" } }] })).toString("base64");
  const quote = decodeQuote(header);
  const GOOD: RunFacts = {
    quote, expectNetwork: "xrpl:1", status: 200, receipt: { success: true, transaction: "A".repeat(64), network: "xrpl:1", payer: B }, buyer: B,
    before: { buyerRlusd: "1", sellerRlusd: "0.35", buyerDrops: "100" }, after: { buyerRlusd: "0.99", sellerRlusd: "0.36", buyerDrops: "90" },
    bodyText: "{}", originals: ["Alice Example"], clientUnresolved: 0, gatewayUnresolved: "0", answered: true,
    ledgerTx: { validated: true, result: "tesSUCCESS", account: B, destination: S, delivered: { currency: quote.asset, issuer: quote.issuer!, value: "0.01" }, feeDrops: "10" },
  };
  const failing = (f: RunFacts) => verdict(f).filter((c) => !c.ok).map((c) => c.name);
  it("adds no check when no model is named (10 checks, as before)", () => {
    assert.equal(verdict(GOOD).length, 10);
    assert.equal(verdict({ ...GOOD, requestedModel: "chainaim/auto", servedModel: "local/qwen2.5-3b" }).length, 10);
  });
  it("passes when the named model served, and shows its zone", () => {
    const checks = verdict({ ...GOOD, requestedModel: "hosted/nemotron-nano-reasoning", servedModel: "hosted/nemotron-nano-reasoning", servedZone: "public-api" });
    assert.equal(checks.length, 11);
    const c = checks.find((x) => x.name === "served by the requested model")!;
    assert.equal(c.ok, true);
    assert.match(c.detail, /hosted\/nemotron-nano-reasoning.*public-api/);
  });
  it("fails when another model served, or none is reported", () => {
    assert.deepEqual(failing({ ...GOOD, requestedModel: "hosted/nemotron-nano-reasoning", servedModel: "local/qwen2.5-3b", servedZone: "local" }), ["served by the requested model"]);
    assert.deepEqual(failing({ ...GOOD, requestedModel: "hosted/nemotron-nano-reasoning" }), ["served by the requested model"]);
  });
});
