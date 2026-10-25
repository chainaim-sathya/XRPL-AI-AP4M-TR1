/**
 * Buy TestNet RLUSD with the account's own TestNet XRP on the XRP Ledger's
 * exchange (AMM pools and order books), for a buyer that cannot use a browser
 * wallet. The account needs XRP above its reserves and an open RLUSD trust
 * line (scripts/trust-line.ts). The seed is read from SEED_PREFIX_TESTNET,
 * optionally loaded from --env-file, and is never printed or saved. TestNet only.
 *
 *   node scripts/buy-rlusd.ts --env-file C:/PRIV-AI-SECRETS/testnet.env --seed-prefix XRPL_SEED_B01 --amount 1 --max-xrp 5 --dry-run
 *   node scripts/buy-rlusd.ts --env-file C:/PRIV-AI-SECRETS/testnet.env --seed-prefix XRPL_SEED_B01 --amount 1 --max-xrp 5
 *
 * --amount        RLUSD to receive, exactly (default 1)
 * --max-xrp       the most XRP the buy may spend; required, no default
 * --slippage-pct  allowance above the quote for price moves before the buy lands (default 2), never above --max-xrp
 * --seed-prefix   the seed variable's prefix (default XRPL_BUYER_SEED, read as PREFIX_TESTNET)
 * --env-file      a .env-format file to read the seed from (kept outside the repository)
 * --dry-run       quote only: show the price and the transaction, sign and send nothing
 */
import { parseArgs } from "node:util";
import { Client, dropsToXrp } from "xrpl";
import { BuyRefused, bestXrpQuote, buyOutcome, buyPayment, parseBuyArgs, sendMaxDrops } from "./buy-rlusd-core.ts";
import { account, DEFAULT_SEED_PREFIX, rlusd, SetupError, type ScriptAccount } from "./xrpl.ts";

const { values } = parseArgs({
  options: {
    amount: { type: "string", default: "1" },
    "max-xrp": { type: "string" },
    "slippage-pct": { type: "string", default: "2" },
    "seed-prefix": { type: "string", default: DEFAULT_SEED_PREFIX },
    "env-file": { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

let who: ScriptAccount | undefined;
let token: { currency: string; issuer: string } | undefined;
let args: ReturnType<typeof parseBuyArgs> | undefined;
try {
  args = parseBuyArgs(values);
  if (values["env-file"]) {
    try {
      process.loadEnvFile(values["env-file"]);
    } catch (e) {
      throw new SetupError(`cannot read --env-file ${values["env-file"]}: ${(e as Error).message}`);
    }
  }
  const env = { ...process.env, XRPL_NETWORK: "testnet" };
  who = account(env, { seedPrefix: values["seed-prefix"] });
  token = rlusd(env);
} catch (e) {
  if (!(e instanceof SetupError) && !(e instanceof BuyRefused)) throw e;
  console.error(e.message);
  process.exitCode = 2;
}

if (who && token && args) {
  const address = who.wallet.classicAddress;
  console.log(`account ${address}`);
  const client = new Client(who.wsUrl);
  await client.connect();
  // process.exitCode, not process.exit(): exiting right after a network call crashes Node on Windows.
  try {
    const lines = await client.request({ command: "account_lines", account: address, peer: token.issuer, ledger_index: "validated" });
    const line = lines.result.lines.find((l) => l.currency === token!.currency);
    if (!line) throw new BuyRefused(`no RLUSD trust line on ${address}: run scripts/trust-line.ts first`);
    console.log(`RLUSD balance before: ${line.balance}`);

    const found = await client.request({
      command: "ripple_path_find",
      source_account: address,
      destination_account: address,
      destination_amount: { currency: token.currency, issuer: token.issuer, value: args.amount },
      source_currencies: [{ currency: "XRP" }],
      ledger_index: "validated",
    } as never);
    const quote = bestXrpQuote((found as { result: Parameters<typeof bestXrpQuote>[0] }).result);
    if (!quote) throw new BuyRefused(`the ledger found no way to buy ${args.amount} RLUSD with XRP right now`);
    const sendMax = sendMaxDrops(quote.drops, args.maxXrp, args.slippagePct);
    console.log(`quote: ${args.amount} RLUSD for ${dropsToXrp(quote.drops.toString())} XRP; will spend at most ${dropsToXrp(sendMax.toString())} XRP`);

    const tx = buyPayment(address, token, args.amount, sendMax, quote.paths);
    if (values["dry-run"]) {
      console.log(`transaction (not sent): ${JSON.stringify({ ...tx, Paths: tx.Paths ? `${(tx.Paths as unknown[]).length} path(s)` : undefined })}`);
      console.log("dry run: nothing was signed or sent");
    } else {
      const sent = await client.submitAndWait(tx as never, { wallet: who.wallet });
      const outcome = buyOutcome(sent.result.meta, token);
      if (outcome.result === "tesSUCCESS") {
        console.log(`bought ${outcome.delivered ?? args.amount} RLUSD; transaction ${sent.result.hash}`);
      } else {
        console.error(`the ledger refused the buy (${outcome.result}); transaction ${sent.result.hash}`);
        process.exitCode = 1;
      }
      console.log(`https://testnet.xrpl.org/transactions/${sent.result.hash}`);
      const after = await client.request({ command: "account_lines", account: address, peer: token.issuer, ledger_index: "validated" });
      console.log(`RLUSD balance after: ${after.result.lines.find((l) => l.currency === token!.currency)?.balance ?? "unknown"}`);
    }
  } catch (e) {
    if (!(e instanceof BuyRefused)) throw e;
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    await client.disconnect();
  }
}
