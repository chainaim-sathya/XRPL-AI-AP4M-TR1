import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { networkInfo, networkName, readQuote } from "../src/wallets.ts";

const TESTNET = "xrpl:1";
const RLUSD = "524C555344000000000000000000000000000000";
const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const PAYTO = "rwaugYNb1VYhPVhV3oEa77Pa9itayatbJd";

const header = (accepts: unknown) => Buffer.from(JSON.stringify({ accepts })).toString("base64");
const quoteFetch = (status: number, accepts?: unknown) => async () =>
  new Response("{}", { status, headers: accepts === undefined ? {} : { "payment-required": header(accepts) } });

describe("networkName", () => {
  it("ARCH-010 recognises TestNet and MainNet by their CAIP-2 ids", () => {
    assert.equal(networkName(TESTNET), "testnet");
    assert.equal(networkName("xrpl:0"), "mainnet");
    assert.equal(networkName("xrpl:2"), "unknown");
    assert.equal(networkName("eip155:8453"), "unknown");
  });
});

describe("readQuote", () => {
  it("ARCH-004 reads the pay-to address, network, RLUSD currency code and issuer, and the price as the decimal it is quoted in", async () => {
    const q = await readQuote("http://paywall.test", "/v1/chat/completions", quoteFetch(402, [{ network: TESTNET, amount: "0.01", asset: RLUSD, payTo: PAYTO, extra: { issuer: ISSUER } }]));
    assert.deepEqual(q, { payTo: PAYTO, network: TESTNET, asset: RLUSD, issuer: ISSUER, price: 0.01 });
    // The amount is never divided by a million: a $0.002 answer costs 0.002, not 0.000000002.
    const cheap = await readQuote("http://paywall.test", "/v1/privacy/scan", quoteFetch(402, [{ network: TESTNET, amount: "0.002", asset: RLUSD, payTo: PAYTO, extra: { issuer: ISSUER } }]));
    assert.equal(cheap.price, 0.002);
  });

  it("posts to the route it was given", async () => {
    let seen = "";
    await readQuote("http://paywall.test", "/v1/privacy/scan", async (input) => {
      seen = String(input);
      return new Response("{}", { status: 402, headers: { "payment-required": header([{ network: TESTNET, amount: "0.002", asset: RLUSD, payTo: PAYTO, extra: { issuer: ISSUER } }]) } });
    });
    assert.equal(seen, "http://paywall.test/v1/privacy/scan");
  });

  it("fails clearly when the paywall does not quote a price", async () => {
    await assert.rejects(readQuote("http://paywall.test", "/x", quoteFetch(503)), /did not quote a price \(HTTP 503\)/);
  });

  it("fails clearly when the quote has the wrong shape", async () => {
    await assert.rejects(readQuote("http://paywall.test", "/x", quoteFetch(402, [{ network: TESTNET }])), /not in the expected shape/);
    // An RLUSD price without its issuer cannot be paid.
    await assert.rejects(readQuote("http://paywall.test", "/x", quoteFetch(402, [{ network: TESTNET, amount: "0.01", asset: RLUSD, payTo: PAYTO }])), /not in the expected shape/);
  });
});

describe("networkInfo", () => {
  it("ARCH-015 gives the CAIP-2 id and XRP Ledger server for a known network, and null otherwise", () => {
    assert.deepEqual(networkInfo("testnet"), { caip2: "xrpl:1", wsUrl: "wss://s.altnet.rippletest.net:51233/" });
    assert.equal(networkInfo("unknown"), null);
  });
});
