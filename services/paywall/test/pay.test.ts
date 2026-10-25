/**
 * scripts/pay.ts against a local paywall with the stub facilitator: --dry-run
 * reads the price and pays nothing. The paying path needs a funded buyer
 * account; the owner runs it (docs/deploy/railway.md).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { DEFAULT_RLUSD_CURRENCY_CODE, DEFAULT_RLUSD_ISSUER_TESTNET } from "../src/config.ts";
import { close, listen, PAY_TO, startPaywall, stubFacilitator, stubGateway } from "./stubs.ts";

const cwd = fileURLToPath(new URL("../", import.meta.url));

/** Async on purpose: the paywall runs in this process and must keep answering. */
function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/pay.ts", ...args], { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("scripts/pay.ts", () => {
  const facilitator = stubFacilitator();
  const gateway = stubGateway();
  let paywall: { url: string; close: () => Promise<void> };
  before(async () => {
    paywall = await startPaywall({
      XRPL_PAY_TO_TESTNET: PAY_TO,
      GATEWAY_URL: await listen(gateway.server),
      CHAINAIM_GATEWAY_KEY: "test-key",
      FACILITATOR_URL_TESTNET: await listen(facilitator.server),
    });
  });
  after(async () => {
    await paywall.close();
    await close(facilitator.server);
    await close(gateway.server);
  });

  it("ARCH-004 --dry-run shows the price in RLUSD, the issuer, network, payTo and invoice, and pays nothing", async () => {
    const r = await run(["--dry-run", `${paywall.url}/v1/privacy/scan`, JSON.stringify({ text: "hi" })]);
    assert.equal(r.code, 0, r.stderr);
    // 0.01, not 0.00000001: the RLUSD amount is a decimal and is never divided by a million.
    assert.ok(r.stdout.includes(`price 0.01 RLUSD (asset ${DEFAULT_RLUSD_CURRENCY_CODE}, issuer ${DEFAULT_RLUSD_ISSUER_TESTNET}) on xrpl:1`), r.stdout);
    assert.match(r.stdout, new RegExp(`to ${PAY_TO}; invoice=[0-9A-F]{32}\n`));
    assert.ok(r.stdout.includes("bazaar=yes"), r.stdout);
    assert.ok(!facilitator.calls.includes("/verify") && !facilitator.calls.includes("/settle"), "nothing was verified or settled");
  });

  it("needs a URL", async () => {
    const r = await run([]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes("usage"), r.stderr);
  });

  it("ARCH-011 refuses to pay without XRPL_BUYER_SEED_TESTNET", async () => {
    const r = await run([`${paywall.url}/v1/privacy/scan`, JSON.stringify({ text: "hi" })], { XRPL_NETWORK: "", XRPL_BUYER_SEED_TESTNET: "" });
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes("XRPL_BUYER_SEED_TESTNET is required"), r.stderr);
    assert.ok(!facilitator.calls.includes("/verify"), "nothing was presented for payment");
  });

  it("ARCH-010 reads the buyer seed of the network XRPL_NETWORK names", async () => {
    const r = await run([`${paywall.url}/v1/privacy/scan`, JSON.stringify({ text: "hi" })], { XRPL_NETWORK: "mainnet", XRPL_BUYER_SEED_MAINNET: "", XRPL_BUYER_SEED_TESTNET: "unused" });
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes("XRPL_BUYER_SEED_MAINNET is required"), r.stderr);
  });

  it("refuses a seed that is not a family seed, without echoing it", async () => {
    const r = await run([`${paywall.url}/v1/privacy/scan`, JSON.stringify({ text: "hi" })], { XRPL_NETWORK: "", XRPL_BUYER_SEED_TESTNET: "twenty five words are not a seed" });
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes("XRPL_BUYER_SEED_TESTNET is not a valid family seed"), r.stderr);
    assert.ok(!r.stderr.includes("twenty five") && !r.stdout.includes("twenty five"), "the seed is never printed");
  });
});
