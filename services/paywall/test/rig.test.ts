/**
 * The test rig (scripts/rig.ts, scripts/rig-core.ts) against a local paywall
 * with the stub facilitator and a stand-in for the XRP Ledger server. There
 * is no ARCH-ID for the rig yet (architecture-xrpl-migration.md ends at
 * ARCH-018), so these tests are named L0-RIG; ARCH-IDs are given where the
 * behaviour is one an existing requirement covers.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { Wallet } from "xrpl";
import type { LedgerRequest } from "../../web/src/balance.ts";
import { checkDistinct, loadTenants, prepareRequest, runTenant, type CallRecord, type Tenant } from "../scripts/rig-core.ts";
import { SetupError, seedBuyer } from "../scripts/xrpl.ts";
import { close, listen, PAY_TO, startPaywall, stubFacilitator, stubGateway } from "./stubs.ts";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const REPO_TENANTS = fileURLToPath(new URL("../../../rig/tenants", import.meta.url));

const ledger: LedgerRequest = async (command) =>
  ({
    server_info: { info: { network_id: 1 } },
    account_info: { account_data: { Sequence: 41, Balance: "25000000" } },
    fee: { drops: { open_ledger_fee: "12" } },
    ledger: { ledger_index: 9_000_000 },
  })[command] as Record<string, unknown>;

function tenantsDir(tenants: Record<string, { tenant: unknown; queries: unknown }>): string {
  const dir = mkdtempSync(join(tmpdir(), "rig-tenants-"));
  for (const [folder, t] of Object.entries(tenants)) {
    mkdirSync(join(dir, folder));
    writeFileSync(join(dir, folder, "tenant.json"), JSON.stringify(t.tenant));
    writeFileSync(join(dir, folder, "queries.json"), JSON.stringify(t.queries));
  }
  return dir;
}

function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/rig.ts", ...args], { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const buyerFor = (wallet: Wallet) => seedBuyer({ networkName: "testnet", network: "xrpl:1", wsUrl: "wss://unused.example", wallet });

describe("rig tenants", () => {
  it("L0-RIG loads the repository's tenants, and every one of their texts masks cleanly", () => {
    const tenants = loadTenants(REPO_TENANTS);
    assert.deepEqual(tenants.map((t) => t.id), ["t01", "t02", "t03"]);
    for (const t of tenants) {
      let maskedInTenant = 0;
      for (const q of t.queries) {
        // prepareRequest refuses a text whose masked form still holds something to mask.
        const { bodyText, counts } = prepareRequest("scan", q, 256);
        maskedInTenant += Object.values(counts).reduce((a, b) => a + b, 0);
        assert.ok(!/@[a-z]+\.example/.test(bodyText), `${t.id}: no e-mail address leaves unmasked`);
      }
      assert.ok(maskedInTenant > 0, `${t.id}: its texts carry identifiers for the masking to show`);
    }
  });

  it("L0-RIG refuses a tenant whose id is not its folder, a bad seed prefix, or no queries", () => {
    const good = { tenant: { id: "a", name: "A", seedPrefix: "XRPL_SEED_A" }, queries: ["hello"] };
    const cases = [
      { a: { ...good, tenant: { ...good.tenant, id: "b" } } },
      { a: { ...good, tenant: { ...good.tenant, seedPrefix: "seed-a" } } },
      { a: { ...good, queries: [] } },
    ];
    for (const c of cases) {
      const dir = tenantsDir(c);
      assert.throws(() => loadTenants(dir), SetupError);
      rmSync(dir, { recursive: true });
    }
    const dir = tenantsDir({ a: good });
    assert.throws(() => loadTenants(dir, ["zz"]), /no tenant folder for zz/);
    rmSync(dir, { recursive: true });
  });

  it("L0-RIG refuses two tenants that share one wallet", () => {
    const wallet = Wallet.generate();
    const t = (id: string): Tenant => ({ id, name: id, seedPrefix: "X", queries: ["q"] });
    assert.throws(() => checkDistinct([{ tenant: t("a"), buyer: buyerFor(wallet) }, { tenant: t("b"), buyer: buyerFor(wallet) }]), /use the same account/);
  });
});

describe("runTenant against a stub paywall", () => {
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

  const tenant: Tenant = { id: "t01", name: "Test", seedPrefix: "X", queries: ["Invoice overdue. Contact: priya.vq@loomtest.example"] };

  it("L0-RIG pays each call in turn and stops before signing once the tenant's spending ceiling is reached", async () => {
    const records: CallRecord[] = [];
    const settlesBefore = facilitator.calls.filter((c) => c === "/settle").length;
    const summary = await runTenant(tenant, buyerFor(Wallet.generate()), { url: paywall.url, endpoint: "scan", calls: 3, intervalMs: 0, maxSpend: "0.02", maxTokens: 256 }, { write: (r) => records.push(r), ledger });
    assert.deepEqual(records.map((r) => r.result), ["settled", "settled", "stopped"]);
    assert.equal(summary.settled, 2);
    assert.equal(summary.spent, "0.02");
    assert.match(summary.stoppedBy ?? "", /above the most this buyer may pay now \(0 RLUSD\)/);
    assert.equal(facilitator.calls.filter((c) => c === "/settle").length - settlesBefore, 2, "the third call was never presented");
    assert.equal(records[0].transaction, "TX-STUB-1");
    assert.deepEqual(records[0].masked, { EMAIL_ADDRESS: 1 });
  });

  it("L0-RIG sends only masked text, and records no text at all", async () => {
    const records: CallRecord[] = [];
    const seenBefore = gateway.seen.length;
    await runTenant(tenant, buyerFor(Wallet.generate()), { url: paywall.url, endpoint: "scan", calls: 1, intervalMs: 0, maxSpend: "0.2", maxTokens: 256 }, { write: (r) => records.push(r), ledger });
    const sent = gateway.seen.slice(seenBefore).map((s) => s.body).join("\n");
    assert.ok(sent.includes("<C_EMAIL_ADDRESS_1>"), sent);
    assert.ok(!sent.includes("priya.vq@loomtest.example"), "the address never reached the server");
    assert.ok(!JSON.stringify(records).includes("priya") && !JSON.stringify(records).includes("Invoice"), "records hold no text");
  });

  it("ARCH-011 dry run: checks every tenant's seed, shows the price, and pays nothing", async () => {
    const dir = tenantsDir({
      ra: { tenant: { id: "ra", name: "A", seedPrefix: "XRPL_SEED_RIGTEST_A" }, queries: ["hello"] },
      rb: { tenant: { id: "rb", name: "B", seedPrefix: "XRPL_SEED_RIGTEST_B" }, queries: ["hello"] },
    });
    const a = Wallet.generate();
    const b = Wallet.generate();
    const before = facilitator.calls.length;
    const r = await run(["--url", paywall.url, "--tenants", dir, "--dry-run"], { XRPL_NETWORK: "testnet", XRPL_SEED_RIGTEST_A_TESTNET: a.seed!, XRPL_SEED_RIGTEST_B_TESTNET: b.seed! });
    rmSync(dir, { recursive: true });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(`payer ${a.classicAddress}`) && r.stdout.includes(`payer ${b.classicAddress}`), r.stdout);
    assert.ok(r.stdout.includes(`price 0.01 RLUSD on xrpl:1 to ${PAY_TO}`), r.stdout);
    assert.ok(!facilitator.calls.slice(before).includes("/verify"), "nothing was presented for payment");
    assert.ok(!r.stdout.includes(a.seed!) && !r.stderr.includes(a.seed!), "no seed is printed");
  });

  it("ARCH-011 names a tenant's missing seed variable and pays nothing", async () => {
    const dir = tenantsDir({ rc: { tenant: { id: "rc", name: "C", seedPrefix: "XRPL_SEED_RIGTEST_C" }, queries: ["hello"] } });
    const r = await run(["--url", paywall.url, "--tenants", dir], { XRPL_NETWORK: "testnet", XRPL_SEED_RIGTEST_C_TESTNET: "" });
    rmSync(dir, { recursive: true });
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes("XRPL_SEED_RIGTEST_C_TESTNET is required"), r.stderr);
  });

  it("L0-RIG refuses a bad --url, --endpoint or --calls before reading any seed", async () => {
    for (const args of [["--url", "ftp://x"], ["--url", paywall.url, "--endpoint", "pay"], ["--url", paywall.url, "--calls", "0"]]) {
      const r = await run(args, {});
      assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`);
    }
  });
});
