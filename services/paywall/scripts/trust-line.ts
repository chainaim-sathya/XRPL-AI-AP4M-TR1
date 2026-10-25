/**
 * Open a trust line from a TestNet account to the RLUSD issuer so it can
 * receive and hold RLUSD. Both the payTo account and the buyer need this
 * before a payment. The account's family seed is read from
 * XRPL_BUYER_SEED_TESTNET, as in pay.ts, and never printed or saved; to open
 * the payTo account's line, put that account's seed in the variable for this
 * one command. The account needs TestNet XRP first: the base reserve, the
 * owner reserve for the trust line, and the fee. TestNet only.
 *
 *   read -rsp "seed: " XRPL_BUYER_SEED_TESTNET && export XRPL_BUYER_SEED_TESTNET && node scripts/trust-line.ts [LIMIT]
 *
 * LIMIT is the most RLUSD the account agrees to hold (default 1000000).
 */
import { Client, dropsToXrp, TrustSetFlags } from "xrpl";
import { account, reserves, rlusd, SetupError, type ScriptAccount } from "./xrpl.ts";

const FAUCET = "https://xrpl.org/resources/dev-tools/xrp-faucets";
const [limit = "1000000"] = process.argv.slice(2);

let who: ScriptAccount | undefined;
let token: { currency: string; issuer: string } | undefined;
try {
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(limit) || Number(limit) <= 0) throw new SetupError(`"${limit}" is not a positive amount of RLUSD`);
  who = account({ ...process.env, XRPL_NETWORK: "testnet" });
  token = rlusd({ ...process.env, XRPL_NETWORK: "testnet" });
} catch (e) {
  if (!(e instanceof SetupError)) throw e;
  console.error(e.message);
  process.exitCode = 2;
}

if (who && token) {
  const address = who.wallet.classicAddress;
  console.log(`account ${address}`);
  const client = new Client(who.wsUrl);
  await client.connect();
  // process.exitCode, not process.exit(): exiting right after a network call crashes Node on Windows.
  try {
    const info = await client.request({ command: "account_info", account: address, ledger_index: "validated" }).catch((e: { data?: { error?: string } }) => {
      if (e?.data?.error === "actNotFound") return undefined;
      throw e;
    });
    if (!info) {
      console.error(`This account is not on TestNet yet. Fund this address at ${FAUCET}, then run this again.`);
      process.exitCode = 1;
    } else {
      const xrp = Number(dropsToXrp(info.result.account_data.Balance));
      const owned = info.result.account_data.OwnerCount;
      const lines = await client.request({ command: "account_lines", account: address, peer: token.issuer, ledger_index: "validated" });
      const line = lines.result.lines.find((l) => l.currency === token!.currency);
      console.log(`XRP ${xrp}; RLUSD ${line ? `trust line open, balance ${line.balance}, limit ${line.limit}` : "no trust line"}`);
      const { baseXrp, ownerXrp } = await reserves(client);
      const needed = baseXrp + ownerXrp * (owned + 1);
      if (!line && xrp <= needed) {
        console.error(`Too little XRP: with a trust line this account must keep ${needed} XRP (base reserve ${baseXrp}, plus ${ownerXrp} for each of its ${owned + 1} objects), and pay the fee. Fund this address at ${FAUCET}, then run this again.`);
        process.exitCode = 1;
      } else if (!line) {
        const result = await client.submitAndWait(
          { TransactionType: "TrustSet", Account: address, LimitAmount: { currency: token.currency, issuer: token.issuer, value: limit }, Flags: TrustSetFlags.tfSetNoRipple },
          { wallet: who.wallet },
        );
        const outcome = typeof result.result.meta === "object" ? result.result.meta.TransactionResult : "unknown";
        if (outcome === "tesSUCCESS") {
          console.log(`trust line to RLUSD opened; transaction ${result.result.hash}`);
        } else {
          console.error(`the ledger refused the trust line (${outcome}); transaction ${result.result.hash}`);
          process.exitCode = 1;
        }
        console.log(`https://testnet.xrpl.org/transactions/${result.result.hash}`);
      }
    }
  } finally {
    await client.disconnect();
  }
}
