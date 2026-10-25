/**
 * P14: the paywall's phase log (PAYWALL_PHASE_LOG). With it on, each
 * payment_settled line carries capacity, verify, gateway and settle times in
 * whole milliseconds; with it off (the default) the line is unchanged.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { settledPhases } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { close, listen, PAY_TO, startPaywall, stubFacilitator, stubGateway } from "./stubs.ts";

const KEY = "test-gateway-key";
type PaymentRequired = { accepts: Record<string, any>[]; resource: { url: string } };
const decode = (header: string | null): PaymentRequired => JSON.parse(Buffer.from(header!, "base64").toString("utf8"));
let paymentCount = 0;
const paymentFor = (required: PaymentRequired): string =>
  Buffer.from(
    JSON.stringify({ x402Version: 2, accepted: required.accepts[0], payload: { signedTxBlob: Buffer.from(`phase payment ${++paymentCount}`).toString("hex").toUpperCase() }, resource: required.resource }),
  ).toString("base64");

describe("P14 paywall phase log", () => {
  const facilitator = stubFacilitator();
  const gateway = stubGateway();
  const onLogs: string[] = [];
  const offLogs: string[] = [];
  let on: { url: string; close: () => Promise<void> };
  let off: { url: string; close: () => Promise<void> };

  before(async () => {
    const facilitatorUrl = await listen(facilitator.server);
    const gatewayUrl = await listen(gateway.server);
    const env = { XRPL_PAY_TO_TESTNET: PAY_TO, GATEWAY_URL: gatewayUrl, CHAINAIM_GATEWAY_KEY: KEY, FACILITATOR_URL_TESTNET: facilitatorUrl };
    on = await startPaywall({ ...env, PAYWALL_PHASE_LOG: "on" }, (line) => onLogs.push(line));
    off = await startPaywall(env, (line) => offLogs.push(line));
  });
  after(async () => {
    await on.close();
    await off.close();
    await close(facilitator.server);
    await close(gateway.server);
  });

  const paidChat = async (url: string): Promise<Response> => {
    const body = JSON.stringify({ messages: [{ role: "user", content: "Jane Roe" }] });
    const headers = { "content-type": "application/json" };
    const quote = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers, body });
    assert.equal(quote.status, 402);
    const required = decode(quote.headers.get("payment-required"));
    return fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { ...headers, "payment-signature": paymentFor(required) }, body });
  };

  it("P14 on: payment_settled carries capacity, verify, gateway and settle ms, numbers only", async () => {
    gateway.state.delayMs = 300;
    try {
      const r = await paidChat(on.url);
      assert.equal(r.status, 200);
      await r.text();
    } finally {
      gateway.state.delayMs = 0;
    }
    assert.equal(onLogs.length, 1);
    const line = JSON.parse(onLogs[0]);
    assert.equal(line.event, "payment_settled");
    assert.deepEqual(Object.keys(line.phases).sort(), ["capacity_ms", "gateway_ms", "settle_ms", "verify_ms"]);
    for (const [name, value] of Object.entries(line.phases)) assert.ok(Number.isInteger(value) && (value as number) >= 0, `${name} is a whole number of ms`);
    assert.ok(line.phases.gateway_ms >= 250, `the gateway's 300 ms delay shows in gateway_ms (${line.phases.gateway_ms})`);
    assert.ok(!onLogs[0].includes("Jane"), "no request text in the payment log");
  });

  it("P14 off (default): payment_settled has no phases", async () => {
    const r = await paidChat(off.url);
    assert.equal(r.status, 200);
    await r.text();
    assert.equal(offLogs.length, 1);
    assert.equal("phases" in JSON.parse(offLogs[0]), false);
  });

  it("P14 settledPhases derives each phase from the marks and needs every mark", () => {
    assert.deepEqual(settledPhases({ capacityMs: 12.4, verifyAt: 100, gatewayStart: 1100.6, gatewayEnd: 4100 }, 9100.2), {
      capacity_ms: 12,
      verify_ms: 1001,
      gateway_ms: 2999,
      settle_ms: 5000,
    });
    assert.equal(settledPhases({ verifyAt: 1, gatewayStart: 2 }, 3), undefined);
  });

  it("P14 PAYWALL_PHASE_LOG accepts only on or off", () => {
    const env = { XRPL_PAY_TO_TESTNET: PAY_TO, GATEWAY_URL: "http://gateway.local:8700", CHAINAIM_GATEWAY_KEY: KEY };
    assert.equal(loadConfig(env).phaseLog, false);
    assert.equal(loadConfig({ ...env, PAYWALL_PHASE_LOG: "on" }).phaseLog, true);
    assert.throws(() => loadConfig({ ...env, PAYWALL_PHASE_LOG: "yes" }), /PAYWALL_PHASE_LOG must be on or off/);
  });
});
