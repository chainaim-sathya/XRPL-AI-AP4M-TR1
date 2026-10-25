/**
 * The test rig: several tenants, each with its own TestNet wallet, pay a
 * paywall route in RLUSD over and over, so the paywall's payment log fills
 * the way it would with many agents. Logic in scripts/rig-core.ts.
 *
 *   node scripts/rig.ts --url http://127.0.0.1:8080 --dry-run
 *   node scripts/rig.ts --url http://127.0.0.1:8080 --calls 10
 *
 * --url           the paywall's http(s) address (required)
 * --tenants       folder of tenant folders (default: rig/tenants at the repository root)
 * --only          comma-separated tenant ids to run (default: all)
 * --endpoint      scan (default), mask or chat
 * --calls         calls per tenant, 1 to 1000 (default 10)
 * --interval-ms   pause between one tenant's calls (default 2000)
 * --max-spend     the most RLUSD one tenant may spend in this run (default 0.2)
 * --max-tokens    longest chat answer, 1 to 1024 (default 256)
 * --out           folder for the run's records (default: rig/out at the repository root)
 * --dry-run       check every tenant's seed and masking, show the price, pay nothing
 *
 * Each tenant's seed is read from the variable its tenant.json names
 * (seedPrefix + _TESTNET or _MAINNET), from the shell or the repository's
 * .env, and is never printed or written. Exit code: 0 when every tenant's
 * calls all settled (or the dry run passed), 1 when any did not, 2 for a
 * set-up problem found before anything was paid.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ENDPOINTS, checkDistinct, loadTenants, prepareRequest, runTenant, type CallRecord, type Endpoint, type RunOptions, type TenantSummary } from "./rig-core.ts";
import { account, decimalUnits, SetupError, seedBuyer, withLedger } from "./xrpl.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    tenants: { type: "string", default: join(REPO, "rig", "tenants") },
    only: { type: "string" },
    endpoint: { type: "string", default: "scan" },
    calls: { type: "string", default: "10" },
    "interval-ms": { type: "string", default: "2000" },
    "max-spend": { type: "string", default: "0.2" },
    "max-tokens": { type: "string", default: "256" },
    out: { type: "string", default: join(REPO, "rig", "out") },
    "dry-run": { type: "boolean", default: false },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function whole(name: string, raw: string, min: number, max: number): number {
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < min || n > max) fail(`--${name} must be a whole number from ${min} to ${max}`);
  return n;
}

const base = values.url?.replace(/\/+$/, "");
if (!base || !/^https?:\/\//.test(base) || !URL.canParse(base)) fail("--url is required and must be the paywall's http(s) address, e.g. http://127.0.0.1:8080");
const endpoint = values.endpoint as Endpoint;
if (!Object.hasOwn(ENDPOINTS, endpoint)) fail("--endpoint must be scan, mask or chat");
const options: RunOptions = {
  url: base,
  endpoint,
  calls: whole("calls", values.calls, 1, 1000),
  intervalMs: whole("interval-ms", values["interval-ms"], 0, 600_000),
  maxSpend: values["max-spend"],
  maxTokens: whole("max-tokens", values["max-tokens"], 1, 1024),
};

let prepared;
try {
  if (decimalUnits(options.maxSpend) <= 0n) throw new SetupError("--max-spend must be above 0");
  const tenants = loadTenants(values.tenants, values.only?.split(",").map((s) => s.trim()).filter(Boolean));
  prepared = tenants.map((tenant) => ({ tenant, buyer: seedBuyer(account(process.env, { seedPrefix: tenant.seedPrefix })) }));
  checkDistinct(prepared);
  // Every text is masked and checked now, so a bad query file stops the run before anything is paid.
  for (const { tenant } of prepared) {
    tenant.queries.forEach((q, i) => {
      try {
        prepareRequest(endpoint, q, options.maxTokens);
      } catch (e) {
        if (!(e instanceof SetupError)) throw e;
        throw new SetupError(`${tenant.id}/queries.json item ${i + 1}: ${e.message}`);
      }
    });
  }
} catch (e) {
  if (!(e instanceof SetupError)) throw e;
  fail(e.message);
}

const url = `${base}${ENDPOINTS[endpoint]}`;
for (const { tenant, buyer } of prepared) console.log(`tenant ${tenant.id} (${tenant.name}): payer ${buyer.signer.classicAddress} on ${buyer.network}, ${tenant.queries.length} queries`);

// process.exitCode, not process.exit(), after a network call: exiting right after one crashes Node on Windows.
if (values["dry-run"]) {
  // One unpaid call shows the price every tenant would pay; nothing is signed.
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: prepareRequest(endpoint, prepared[0].tenant.queries[0], options.maxTokens).bodyText });
  const header = r.headers.get("payment-required");
  if (r.status !== 402 || !header) {
    console.error(`HTTP ${r.status} from ${url}: no price was asked: ${(await r.text()).slice(0, 300)}`);
    process.exitCode = 1;
  } else {
    const required = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts: { amount: string; network: string; payTo: string }[] };
    for (const a of required.accepts) console.log(`price ${a.amount} RLUSD on ${a.network} to ${a.payTo}`);
    console.log(`dry run: ${prepared.length} tenants x ${options.calls} calls would spend at most ${options.maxSpend} RLUSD each; nothing was paid`);
    process.exitCode = 0;
  }
} else {
  await run();
}

async function run(): Promise<void> {
  mkdirSync(values.out, { recursive: true });
  const file = join(values.out, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  console.log(`records: ${file}`);

  const write = (record: CallRecord): void => {
    appendFileSync(file, `${JSON.stringify(record)}\n`);
    console.log(`${record.tenant} #${record.call} ${record.result}${record.status ? ` HTTP ${record.status}` : ""}${record.transaction ? ` tx ${record.transaction}` : ""}${record.error ? `: ${record.error}` : ""}`);
  };
  // One ledger connection per tenant for the whole run, closed when the tenant is done.
  const summaries: TenantSummary[] = await Promise.all(
    prepared.map(({ tenant, buyer }) =>
      withLedger(buyer.wsUrl, (ledger) => runTenant(tenant, buyer, options, { write, ledger })).catch((e: unknown): TenantSummary => {
        const message = e instanceof Error ? e.message : String(e);
        write({ ts: new Date().toISOString(), tenant: tenant.id, payer: buyer.signer.classicAddress, call: 0, endpoint, result: "stopped", latencyMs: 0, error: message });
        return { tenant: tenant.id, payer: buyer.signer.classicAddress, settled: 0, notSettled: 0, refused: 0, errors: 0, spent: "0", stoppedBy: message };
      }),
    ),
  );

  for (const s of summaries) {
    console.log(`${s.tenant} ${s.payer}: settled ${s.settled}, not settled ${s.notSettled}, refused ${s.refused}, errors ${s.errors}, spent ${s.spent} RLUSD${s.stoppedBy ? `; stopped: ${s.stoppedBy}` : ""}`);
  }
  const total = summaries.reduce((n, s) => n + s.settled, 0);
  console.log(`settled ${total} of ${prepared.length * options.calls}`);
  appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), summary: summaries })}\n`);
  process.exitCode = total === prepared.length * options.calls ? 0 : 1;
}
