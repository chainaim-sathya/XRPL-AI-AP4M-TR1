/**
 * Send TestNet XRP from one of your accounts to another, to fund it or to see
 * a successful transaction on the explorer. This is a plain transfer, not an
 * x402 payment: the paywall only takes RLUSD. The sender's family seed is read
 * from XRPL_BUYER_SEED_TESTNET, as in pay.ts, and never printed or saved.
 * TestNet only.
 *
 *   read -rsp "seed: " XRPL_BUYER_SEED_TESTNET && export XRPL_BUYER_SEED_TESTNET && node scripts/send-xrp.ts RECEIVER_ADDRESS [XRP]
 *
 * XRP is the amount to send (default 2). The sender keeps its reserve after
 * the transfer: the base reserve plus the owner reserve for each object it
 * owns, such as an RLUSD trust line. A receiver that is not on the ledger yet
 * is created by the transfer, which must then be at least the base reserve.
 */
import { Client, dropsToXrp, isValidClassicAddress, xrpToDrops } from "xrpl";
import { account, reserves, SetupError, type ScriptAccount } from "./xrpl.ts";

const FAUCET = "https://xrpl.org/resources/dev-tools/xrp-faucets";
const [receiver, amountArg = "2"] = process.argv.slice(2);
const amount = Number(amountArg);

let sender: ScriptAccount | undefined;
try {
  if (!receiver) throw new SetupError("usage: node scripts/send-xrp.ts RECEIVER_ADDRESS [XRP]");
  sender = account({ ...process.env, XRPL_NETWORK: "testnet" });
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(amountArg) || amount <= 0) throw new SetupError(`"${amountArg}" is not a positive amount of XRP with at most 6 decimals`);
  if (!isValidClassicAddress(receiver)) throw new SetupError("RECEIVER_ADDRESS is not a valid XRP Ledger address (wrong characters or checksum)");
  if (sender.wallet.classicAddress === receiver) throw new SetupError("Sender and receiver are the same account; send to a different one.");
} catch (e) {
  if (!(e instanceof SetupError)) throw e;
  console.error(e.message);
  process.exitCode = 2;
  sender = undefined;
}

if (sender) {
  const from = sender.wallet.classicAddress;
  console.log(`from ${from}\nto   ${receiver}\nsend ${amount} XRP on TestNet`);
  const client = new Client(sender.wsUrl);
  await client.connect();
  // process.exitCode, not process.exit(): exiting right after a network call crashes Node on Windows.
  try {
    const find = (address: string) =>
      client.request({ command: "account_info", account: address, ledger_index: "validated" }).catch((e: { data?: { error?: string } }) => {
        if (e?.data?.error === "actNotFound") return undefined;
        throw e;
      });
    const info = await find(from);
    const { baseXrp, ownerXrp } = await reserves(client);
    if (!info) {
      console.error(`The sender is not on TestNet yet. Fund it at ${FAUCET}.`);
      process.exitCode = 1;
    } else {
      const balance = Number(dropsToXrp(info.result.account_data.Balance));
      const keep = baseXrp + ownerXrp * info.result.account_data.OwnerCount;
      console.log(`sender balance ${balance} XRP`);
      if (balance - amount <= keep) {
        console.error(`Too little XRP: the sender must keep more than ${keep} XRP after sending (its reserve, and the fee). Send less, or fund it at ${FAUCET}.`);
        process.exitCode = 1;
      } else if (!(await find(receiver)) && amount < baseXrp) {
        console.error(`The receiver is not on TestNet yet, so the first transfer to it must be at least the base reserve of ${baseXrp} XRP.`);
        process.exitCode = 1;
      } else {
        const result = await client.submitAndWait({ TransactionType: "Payment", Account: from, Destination: receiver, Amount: xrpToDrops(amountArg) }, { wallet: sender.wallet });
        const outcome = typeof result.result.meta === "object" ? result.result.meta.TransactionResult : "unknown";
        if (outcome === "tesSUCCESS") {
          console.log(`sent; transaction ${result.result.hash}`);
        } else {
          console.error(`the ledger refused the transfer (${outcome}); transaction ${result.result.hash}`);
          process.exitCode = 1;
        }
        console.log(`https://testnet.xrpl.org/transactions/${result.result.hash}`);
      }
    }
  } finally {
    await client.disconnect();
  }
}
