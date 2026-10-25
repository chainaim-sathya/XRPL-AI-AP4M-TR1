/**
 * Show XRP and RLUSD balances of any accounts, read-only (no seed, nothing
 * signed or sent). Use it before and after a paid call to see the buyer pay
 * and the pay-to account receive. TestNet by default (XRPL_NETWORK selects).
 *
 *   node scripts/balances.ts --title BEFORE --env-file C:/PRIV-AI-SECRETS/testnet.env --buyer-seed-prefix XRPL_SEED_B01 --seller-from-paywall http://127.0.0.1:8080
 *   node scripts/balances.ts --account label=rADDRESS --account rADDRESS
 *
 * --account              label=rADDRESS or rADDRESS; repeat for each account
 * --buyer-seed-prefix    add "buyer": the address derived from the seed in PREFIX_TESTNET (the seed is never printed)
 * --env-file             a .env-format file to read that seed from (kept outside the repository)
 * --seller-from-paywall  add "seller": the pay-to address from this paywall's live chat quote
 * --title                a heading printed first, e.g. BEFORE or AFTER (default: none)
 */
import { parseArgs } from "node:util";
import { Client } from "xrpl";
import { BalancesRefused, formatLine, parseAccounts, readAccountState } from "./balances-core.ts";
import { decodeQuote, E2ERefused } from "./e2e-core.ts";
import { account, rlusd, SetupError, wsUrl } from "./xrpl.ts";

const { values } = parseArgs({
  options: {
    account: { type: "string", multiple: true, default: [] },
    title: { type: "string" },
    "buyer-seed-prefix": { type: "string" },
    "env-file": { type: "string" },
    "seller-from-paywall": { type: "string" },
  },
});

let accounts: ReturnType<typeof parseAccounts> | undefined;
let token: { currency: string; issuer: string } | undefined;
let url: string | undefined;
try {
  const items: string[] = [];
  if (values["env-file"]) {
    try {
      process.loadEnvFile(values["env-file"]);
    } catch (e) {
      throw new SetupError(`cannot read --env-file ${values["env-file"]}: ${(e as Error).message}`);
    }
  }
  if (values["buyer-seed-prefix"]) items.push(`buyer=${account({ ...process.env, XRPL_NETWORK: process.env.XRPL_NETWORK ?? "testnet" }, { seedPrefix: values["buyer-seed-prefix"] }).wallet.classicAddress}`);
  const paywall = values["seller-from-paywall"]?.replace(/\/+$/, "");
  if (paywall) {
    if (!/^https?:\/\//.test(paywall) || !URL.canParse(paywall)) throw new BalancesRefused("--seller-from-paywall must be the paywall's http(s) address");
    let header: string | null;
    try {
      const r = await fetch(`${paywall}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }), signal: AbortSignal.timeout(15000) });
      header = r.headers.get("payment-required");
    } catch (e) {
      throw new BalancesRefused(`the paywall at ${paywall} did not answer: ${(e as Error).message}`);
    }
    try {
      items.push(`seller=${decodeQuote(header).payTo}`);
    } catch (e) {
      if (!(e instanceof E2ERefused)) throw e;
      throw new BalancesRefused(e.message);
    }
  }
  items.push(...(values.account ?? []));
  accounts = parseAccounts(items);
  token = rlusd(process.env);
  url = wsUrl(process.env);
} catch (e) {
  if (!(e instanceof SetupError) && !(e instanceof BalancesRefused)) throw e;
  console.error(e.message);
  process.exitCode = 2;
}

if (accounts && token && url) {
  const client = new Client(url);
  await client.connect();
  // process.exitCode, not process.exit(): exiting right after a network call crashes Node on Windows.
  try {
    const title = values.title?.trim();
    console.log(`${title ? `=== ${title} === ` : ""}balances at ${new Date().toISOString()} (validated ledger)`);
    for (const { label, address } of accounts) {
      const state = await readAccountState(client, address, token);
      console.log(formatLine(label, address, state));
    }
  } finally {
    await client.disconnect();
  }
}
