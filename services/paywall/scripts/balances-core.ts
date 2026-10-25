/**
 * Read-only balances for scripts/balances.ts: checks the addresses given and
 * turns ledger answers into one line per account (XRP and RLUSD). No seed is
 * read; nothing is signed or sent.
 */
import { dropsToXrp, isValidClassicAddress, type Client } from "xrpl";

export class BalancesRefused extends Error {}

/** "label=rADDRESS" or "rADDRESS"; the label defaults to the address. Refuses a bad checksum. */
export function parseAccounts(items: readonly string[]): Array<{ label: string; address: string }> {
  if (items.length === 0) throw new BalancesRefused("give at least one --account rADDRESS (or label=rADDRESS)");
  return items.map((item) => {
    const ix = item.indexOf("=");
    const label = ix > 0 ? item.slice(0, ix).trim() : item.trim();
    const address = (ix > 0 ? item.slice(ix + 1) : item).trim();
    if (!isValidClassicAddress(address)) throw new BalancesRefused(`"${address}" is not a valid XRPL classic address`);
    return { label, address };
  });
}

export type AccountState = { exists: boolean; drops?: string; rlusd?: string };

/** One line: "label  rADDRESS  XRP n  RLUSD n" (or "not on the ledger" / "no RLUSD trust line"). */
export function formatLine(label: string, address: string, s: AccountState): string {
  if (!s.exists) return `${label}  ${address}  not on the ledger`;
  const xrp = `XRP ${dropsToXrp(s.drops ?? "0")}`;
  const rl = s.rlusd === undefined ? "RLUSD no trust line" : `RLUSD ${s.rlusd}`;
  return label === address ? `${address}  ${xrp}  ${rl}` : `${label}  ${address}  ${xrp}  ${rl}`;
}

/** XRP drops and the RLUSD balance of one account at the validated ledger; exists: false when it is not on the ledger. */
export async function readAccountState(client: Client, address: string, token: { currency: string; issuer: string }): Promise<AccountState> {
  try {
    const info = await client.request({ command: "account_info", account: address, ledger_index: "validated" });
    const lines = await client.request({ command: "account_lines", account: address, peer: token.issuer, ledger_index: "validated" });
    const line = lines.result.lines.find((l) => l.currency === token.currency);
    return { exists: true, drops: info.result.account_data.Balance, ...(line ? { rlusd: line.balance } : {}) };
  } catch (e) {
    if ((e as { data?: { error?: string } })?.data?.error !== "actNotFound") throw e;
    return { exists: false };
  }
}
