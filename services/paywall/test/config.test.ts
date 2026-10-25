/**
 * Paywall configuration and the paid-route table (spec section 9).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PRICE, DEFAULT_RLUSD_CURRENCY_CODE, DEFAULT_RLUSD_ISSUER_TESTNET, loadConfig, NETWORKS } from "../src/config.ts";
import { PAID_ROUTES, routesConfig } from "../src/routes.ts";

const PAY_TO = "rwaugYNb1VYhPVhV3oEa77Pa9itayatbJd";
/** A second synthetic XRPL address, standing in for the MainNet RLUSD issuer. */
const ISSUER = "rN5gyNgd5AUh5pNkHfk17cN8QvZEdPKEk6";
const env = { XRPL_PAY_TO_TESTNET: PAY_TO, GATEWAY_URL: "http://gateway.railway.internal:8700", CHAINAIM_GATEWAY_KEY: "test-key" };
const mainnet = { ...env, XRPL_NETWORK: "mainnet", XRPL_PAY_TO_MAINNET: PAY_TO, RLUSD_ISSUER_MAINNET: ISSUER };
/** Every request gets this invoice id in these tests. */
const INVOICE = "INVOICE-1";
const invoiceFor = (): string => INVOICE;

describe("loadConfig", () => {
  it("ARCH-010 defaults to TestNet, the t54 facilitator, TestNet RLUSD and port 8080", () => {
    const c = loadConfig(env);
    assert.equal(c.network, "xrpl:1");
    assert.equal(c.networkName, "testnet");
    assert.equal(c.facilitatorUrl, "https://xrpl-facilitator-testnet.t54.ai");
    assert.equal(c.currencyCode, DEFAULT_RLUSD_CURRENCY_CODE);
    assert.equal(c.issuer, DEFAULT_RLUSD_ISSUER_TESTNET);
    assert.equal(c.sourceTag, 804681468);
    assert.equal(c.maxTimeoutSeconds, 600);
    assert.equal(c.port, 8080);
    assert.equal(c.host, "0.0.0.0");
    assert.equal(c.publicBaseUrl, undefined);
  });

  it("ARCH-010 selects MainNet with XRPL_NETWORK and reads the MainNet variables", () => {
    const c = loadConfig({ ...mainnet, XRPL_PAY_TO_TESTNET: "" });
    assert.deepEqual([c.network, c.networkName, c.payTo, c.issuer], ["xrpl:0", "mainnet", PAY_TO, ISSUER]);
    assert.equal(c.facilitatorUrl, "https://xrpl-facilitator-mainnet.t54.ai");
  });

  it("ARCH-010 validates only the chosen network's variables", () => {
    const blankOther = { XRPL_PAY_TO_MAINNET: "", RLUSD_ISSUER_MAINNET: "", FACILITATOR_URL_MAINNET: "", XRPL_CAIP2_MAINNET: "" };
    assert.equal(loadConfig({ ...env, ...blankOther }).networkName, "testnet");
    const wrongOther = { XRPL_PAY_TO_MAINNET: "not-an-address", RLUSD_ISSUER_MAINNET: "not-an-address", FACILITATOR_URL_MAINNET: "nowhere", XRPL_CAIP2_MAINNET: "other" };
    assert.equal(loadConfig({ ...env, ...wrongOther }).networkName, "testnet");
    assert.equal(loadConfig({ ...mainnet, XRPL_PAY_TO_TESTNET: "not-an-address", RLUSD_ISSUER_TESTNET: "not-an-address" }).networkName, "mainnet");
  });

  it("ARCH-011 reads the chosen network's CAIP-2 id, facilitator, issuer, currency code, source tag and timeout", () => {
    const c = loadConfig({
      ...env,
      XRPL_CAIP2_TESTNET: "xrpl:2",
      FACILITATOR_URL_TESTNET: "http://127.0.0.1:9000/",
      RLUSD_ISSUER_TESTNET: ISSUER,
      RLUSD_CURRENCY_CODE: "5553444300000000000000000000000000000000",
      XRPL_SOURCE_TAG: "7",
      XRPL_MAX_TIMEOUT_SECONDS: "120",
    });
    assert.deepEqual(
      [c.network, c.facilitatorUrl, c.issuer, c.currencyCode, c.sourceTag, c.maxTimeoutSeconds],
      ["xrpl:2", "http://127.0.0.1:9000", ISSUER, "5553444300000000000000000000000000000000", 7, 120],
    );
  });

  it("ARCH-011 has no default MainNet issuer: it is confirmed at deploy time", () => {
    assert.throws(() => loadConfig({ ...mainnet, RLUSD_ISSUER_MAINNET: "" }), /RLUSD_ISSUER_MAINNET is required/);
  });

  it("names the variable that is missing or wrong", () => {
    assert.throws(() => loadConfig({ ...env, XRPL_PAY_TO_TESTNET: "" }), /XRPL_PAY_TO_TESTNET/);
    assert.throws(() => loadConfig({ ...mainnet, XRPL_PAY_TO_MAINNET: "" }), /XRPL_PAY_TO_MAINNET/);
    assert.throws(() => loadConfig({ ...env, GATEWAY_URL: "" }), /GATEWAY_URL/);
    assert.throws(() => loadConfig({ ...env, GATEWAY_URL: "gateway:8700" }), /GATEWAY_URL/);
    assert.throws(() => loadConfig({ ...env, CHAINAIM_GATEWAY_KEY: "" }), /CHAINAIM_GATEWAY_KEY/);
    assert.throws(() => loadConfig({ ...env, XRPL_NETWORK: "betanet" }), /XRPL_NETWORK/);
    assert.throws(() => loadConfig({ ...env, XRPL_NETWORK: "toString" }), /XRPL_NETWORK/);
    assert.throws(() => loadConfig({ ...env, PORT: "eighty" }), /PORT/);
    assert.throws(() => loadConfig({ ...env, XRPL_CAIP2_TESTNET: "eip155:1" }), /XRPL_CAIP2_TESTNET/);
    assert.throws(() => loadConfig({ ...env, FACILITATOR_URL_TESTNET: "facilitator:443" }), /FACILITATOR_URL_TESTNET/);
    assert.throws(() => loadConfig({ ...env, RLUSD_CURRENCY_CODE: "RLUSD" }), /RLUSD_CURRENCY_CODE/);
    assert.throws(() => loadConfig({ ...env, XRPL_SOURCE_TAG: "4294967296" }), /XRPL_SOURCE_TAG/);
    assert.throws(() => loadConfig({ ...env, XRPL_SOURCE_TAG: "-1" }), /XRPL_SOURCE_TAG/);
    assert.throws(() => loadConfig({ ...env, XRPL_MAX_TIMEOUT_SECONDS: "0" }), /XRPL_MAX_TIMEOUT_SECONDS/);
  });

  it("ARCH-012 refuses a pay-to or issuer address whose checksum is wrong, though its length and characters are right", () => {
    const oneCharOff = `${PAY_TO.slice(0, -1)}${PAY_TO.endsWith("d") ? "e" : "d"}`;
    assert.match(oneCharOff, /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/, "it still looks like an address");
    assert.throws(() => loadConfig({ ...env, XRPL_PAY_TO_TESTNET: oneCharOff }), /XRPL_PAY_TO_TESTNET must be an XRPL classic address/);
    assert.throws(() => loadConfig({ ...env, RLUSD_ISSUER_TESTNET: oneCharOff }), /RLUSD_ISSUER_TESTNET must be an XRPL classic address/);
    assert.throws(() => loadConfig({ ...env, XRPL_PAY_TO_TESTNET: "not-an-xrpl-address" }), /XRPL_PAY_TO_TESTNET/);
  });

  it("prices every route at $0.01 unless its PRICE_* variable says otherwise", () => {
    assert.equal(DEFAULT_PRICE, "$0.01");
    assert.deepEqual(loadConfig(env).prices, { scan: "$0.01", mask: "$0.01", chat: "$0.01" });
    assert.deepEqual(loadConfig({ ...env, PRICE_SCAN: "$0.002", PRICE_MASK: "$0.003", PRICE_CHAT: "$0.05" }).prices, { scan: "$0.002", mask: "$0.003", chat: "$0.05" });
  });

  it("refuses a price that is not a positive USD amount with at most 6 decimals", () => {
    for (const bad of ["0.01", "$0", "$0.000000", "$-1", "$abc", "$0.0000001", "$01", "1 USD"]) {
      assert.throws(() => loadConfig({ ...env, PRICE_CHAT: bad }), /PRICE_CHAT/, bad);
    }
  });

  it("needs PUBLIC_BASE_URL to be https and strips a trailing slash", () => {
    assert.equal(loadConfig({ ...env, PUBLIC_BASE_URL: "https://pay.example.com/" }).publicBaseUrl, "https://pay.example.com");
    assert.throws(() => loadConfig({ ...env, PUBLIC_BASE_URL: "http://pay.example.com" }), /PUBLIC_BASE_URL/);
  });
});

describe("paid routes", () => {
  it("prices scan, mask and chat from the configuration", () => {
    assert.deepEqual(
      PAID_ROUTES.map((r) => [r.key, r.priced]),
      [["POST /v1/privacy/scan", "scan"], ["POST /v1/privacy/mask", "mask"], ["POST /v1/chat/completions", "chat"]],
    );
    const routes = routesConfig(loadConfig({ ...env, PRICE_SCAN: "$0.002" }), invoiceFor);
    // ARCH-004: the dollar price is the RLUSD amount, a decimal string, never micro-units.
    assert.equal(routes["POST /v1/privacy/scan"].accepts[0].price({}).amount, "0.002");
    assert.equal(routes["POST /v1/privacy/mask"].accepts[0].price({}).amount, "0.01");
    assert.equal(routes["POST /v1/chat/completions"].accepts[0].price({}).amount, "0.01");
  });

  it("ARCH-013 puts the scheme, network, payTo, RLUSD asset, issuer, invoice, source tag and timeout on every accepts entry", () => {
    const routes = routesConfig(loadConfig({ ...mainnet, PUBLIC_BASE_URL: "https://pay.example.com" }), invoiceFor);
    for (const r of PAID_ROUTES) {
      const entry = routes[r.key];
      assert.equal(entry.accepts.length, 1);
      const { price, ...fixed } = entry.accepts[0];
      assert.deepEqual(fixed, { scheme: "exact", network: NETWORKS.mainnet, payTo: PAY_TO, maxTimeoutSeconds: 600, extra: { sourceTag: 804681468 } });
      assert.deepEqual(price({}), { amount: "0.01", asset: DEFAULT_RLUSD_CURRENCY_CODE, extra: { issuer: ISSUER, invoiceId: INVOICE } });
      assert.equal(entry.resource, `https://pay.example.com${r.path}`);
      assert.equal(entry.mimeType, "application/json");
      assert.equal(entry.description, r.description);
    }
  });

  it("ARCH-013 asks for the invoice of each request, with its payment header when it has one", () => {
    const asked: (string | undefined)[] = [];
    const routes = routesConfig(loadConfig(env), (paymentHeader) => {
      asked.push(paymentHeader);
      return `INVOICE-${asked.length}`;
    });
    const price = routes["POST /v1/privacy/scan"].accepts[0].price;
    assert.equal(price({}).extra.invoiceId, "INVOICE-1");
    assert.equal(price({ paymentHeader: "signed" }).extra.invoiceId, "INVOICE-2");
    assert.deepEqual(asked, [undefined, "signed"]);
  });

  it("leaves the resource URL to the request when PUBLIC_BASE_URL is unset", () => {
    const routes = routesConfig(loadConfig(env), invoiceFor);
    for (const r of PAID_ROUTES) assert.equal("resource" in routes[r.key], false);
  });

  it("declares Bazaar discovery metadata with an input example and an output example", () => {
    const routes = routesConfig(loadConfig(env), invoiceFor);
    type Info = { input: { body: Record<string, unknown> }; output: { example: unknown } };
    const info = (key: string): Info => (routes[key].extensions as { bazaar: { info: Info } }).bazaar.info;
    assert.deepEqual(Object.keys(info("POST /v1/privacy/scan").input.body), ["text"]);
    assert.deepEqual(Object.keys(info("POST /v1/privacy/mask").input.body), ["text"]);
    assert.ok(Array.isArray(info("POST /v1/chat/completions").input.body.messages));
    for (const r of PAID_ROUTES) assert.ok(info(r.key).output.example, `${r.key} has an output example`);
  });
});
