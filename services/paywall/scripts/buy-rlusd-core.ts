/**
 * Buying RLUSD with XRP on the XRP Ledger's own exchange (order books and AMM
 * pools), for an account that already has an RLUSD trust line. The buy is a
 * Payment from the account to itself: Amount is the exact RLUSD to receive,
 * SendMax the most XRP it may spend. Without the partial-payment flag the
 * ledger delivers all of Amount or nothing, and never spends more than
 * SendMax. The price comes from the server's own path search
 * (ripple_path_find) just before signing, capped by the caller's --max-xrp.
 * Used by scripts/buy-rlusd.ts.
 */
import { dropsToXrp, xrpToDrops } from "xrpl";

export class BuyRefused extends Error {}

export type BuyArgs = { amount: string; maxXrp: string; slippagePct: number };

const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;

/** Checks the command-line values; throws BuyRefused naming the bad one. */
export function parseBuyArgs(raw: { amount?: string; "max-xrp"?: string; "slippage-pct"?: string }): BuyArgs {
  const amount = (raw.amount ?? "").trim();
  const maxXrp = (raw["max-xrp"] ?? "").trim();
  const slippage = (raw["slippage-pct"] ?? "").trim();
  if (!DECIMAL.test(amount) || Number(amount) <= 0) throw new BuyRefused(`--amount "${amount}" is not a positive amount of RLUSD`);
  if (!DECIMAL.test(maxXrp) || Number(maxXrp) <= 0) throw new BuyRefused(`--max-xrp "${maxXrp}" is not a positive amount of XRP`);
  if (!DECIMAL.test(slippage) || Number(slippage) > 50) throw new BuyRefused(`--slippage-pct "${slippage}" must be a number from 0 to 50`);
  return { amount, maxXrp, slippagePct: Number(slippage) };
}

export type Token = { currency: string; issuer: string };

/** The cheapest XRP quote in a ripple_path_find result, in drops, with the paths the server found for it. */
export function bestXrpQuote(result: { alternatives?: Array<{ source_amount: unknown; paths_computed?: unknown[] }> }): { drops: bigint; paths: unknown[] } | undefined {
  let best: { drops: bigint; paths: unknown[] } | undefined;
  for (const alt of result.alternatives ?? []) {
    if (typeof alt.source_amount !== "string" || !/^\d+$/.test(alt.source_amount)) continue; // only XRP (drops) sources
    const drops = BigInt(alt.source_amount);
    if (!best || drops < best.drops) best = { drops, paths: alt.paths_computed ?? [] };
  }
  return best;
}

/**
 * The SendMax for a quote: the quote plus the slippage allowance, never above
 * the caller's cap. Refuses when the quote alone is already above the cap.
 */
export function sendMaxDrops(quoteDrops: bigint, maxXrp: string, slippagePct: number): bigint {
  const capDrops = BigInt(xrpToDrops(maxXrp));
  if (quoteDrops > capDrops) throw new BuyRefused(`the ledger quotes ${dropsToXrp(quoteDrops.toString())} XRP, above --max-xrp ${maxXrp}; raise --max-xrp or buy less`);
  const withSlippage = quoteDrops + (quoteDrops * BigInt(Math.round(slippagePct * 100))) / 10000n;
  return withSlippage < capDrops ? withSlippage : capDrops;
}

/** The self-payment that buys `amount` RLUSD for at most `sendMax` drops of XRP. No partial-payment flag. */
export function buyPayment(address: string, token: Token, amount: string, sendMax: bigint, paths: unknown[]): Record<string, unknown> {
  const tx: Record<string, unknown> = {
    TransactionType: "Payment",
    Account: address,
    Destination: address,
    Amount: { currency: token.currency, issuer: token.issuer, value: amount },
    SendMax: sendMax.toString(),
  };
  if (paths.length > 0) tx.Paths = paths;
  return tx;
}

/** What the ledger did, from a validated transaction's metadata: the result code and the RLUSD delivered. */
export function buyOutcome(meta: unknown, token: Token): { result: string; delivered?: string } {
  if (!meta || typeof meta !== "object") return { result: "unknown" };
  const m = meta as { TransactionResult?: string; delivered_amount?: unknown };
  const d = m.delivered_amount as { currency?: string; issuer?: string; value?: string } | undefined;
  const delivered = d && typeof d === "object" && d.currency === token.currency && d.issuer === token.issuer ? d.value : undefined;
  return { result: m.TransactionResult ?? "unknown", ...(delivered !== undefined ? { delivered } : {}) };
}
