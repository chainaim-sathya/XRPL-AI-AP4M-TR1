/**
 * Make a new XRP Ledger account on this machine: its address and family seed,
 * the kind scripts/pay.ts reads from XRPL_BUYER_SEED_TESTNET or
 * XRPL_BUYER_SEED_MAINNET. The same keys work on TestNet and MainNet, but the
 * account exists on a network only once it is funded with the base reserve.
 * Nothing is saved or sent anywhere: copy the seed into a password manager,
 * then clear the terminal.
 *
 *   node scripts/new-account.ts
 */
import { Wallet } from "xrpl";

const wallet = Wallet.generate();

console.log(`address ${wallet.classicAddress}`);
console.log("family seed (save it in a password manager, then clear this terminal):");
console.log(wallet.seed);
