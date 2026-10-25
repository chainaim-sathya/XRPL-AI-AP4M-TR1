/**
 * The checks of the end-to-end paid private chat (scripts/e2e-private-ask.ts): reading the
 * paywall's quote, the balance changes, and the verdict. Pure functions; no network.
 */
import { decimalUnits, unitsToDecimal } from "./xrpl.ts";

export class E2ERefused extends Error {}

export type Quote = { payTo: string; amount: string; network: string; asset: string; issuer?: string };

/** The first offer in a base64 PAYMENT-REQUIRED header. */
export function decodeQuote(header: string | null): Quote {
  if (!header) throw new E2ERefused("the paywall did not quote a price (no PAYMENT-REQUIRED header)");
  let a: Record<string, unknown> | undefined;
  try {
    a = (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts?: Record<string, unknown>[] }).accepts?.[0];
  } catch {
    throw new E2ERefused("the paywall's PAYMENT-REQUIRED header is not base64 JSON");
  }
  if (!a || typeof a.payTo !== "string" || typeof a.amount !== "string" || typeof a.network !== "string" || typeof a.asset !== "string") {
    throw new E2ERefused("the paywall's quote has no payTo, amount, network or asset");
  }
  const extra = a.extra as { issuer?: unknown } | undefined;
  return { payTo: a.payTo, amount: a.amount, network: a.network, asset: a.asset, ...(typeof extra?.issuer === "string" ? { issuer: extra.issuer } : {}) };
}

/** b - a, exactly, for RLUSD balance strings ("0.99"); an absent balance counts as 0. */
export function rlusdDelta(before: string | undefined, after: string | undefined): string {
  const d = decimalUnits(after ?? "0") - decimalUnits(before ?? "0");
  return d < 0n ? `-${unitsToDecimal(-d)}` : `+${unitsToDecimal(d)}`;
}

export type Snapshot = { buyerRlusd?: string; sellerRlusd?: string; buyerDrops?: string; sellerDrops?: string };

/** True once the validated ledger shows the buyer down and the seller up by the price. */
export function settledIn(before: Snapshot, after: Snapshot, amount: string): boolean {
  return rlusdDelta(before.buyerRlusd, after.buyerRlusd) === `-${unitsToDecimal(decimalUnits(amount))}` && rlusdDelta(before.sellerRlusd, after.sellerRlusd) === `+${unitsToDecimal(decimalUnits(amount))}`;
}

/** The payment as the validated ledger records it (the "tx" method's answer). */
export type LedgerTx = { validated: boolean; result: string; account: string; destination: string; delivered?: { currency: string; issuer: string; value: string }; feeDrops: string };

/** Reads a "tx" answer: api_version 2 keeps the fields under tx_json, api_version 1 at the top. A delivery in XRP (drops) has no token, so no `delivered`. */
export function ledgerTxFrom(r: Record<string, unknown>): LedgerTx {
  const tx = (r.tx_json && typeof r.tx_json === "object" ? r.tx_json : r) as Record<string, unknown>;
  const meta = (r.meta && typeof r.meta === "object" ? r.meta : {}) as { TransactionResult?: string; delivered_amount?: unknown };
  const d = meta.delivered_amount as { currency?: unknown; issuer?: unknown; value?: unknown } | undefined;
  const delivered = d && typeof d === "object" && typeof d.currency === "string" && typeof d.issuer === "string" && typeof d.value === "string" ? { currency: d.currency, issuer: d.issuer, value: d.value } : undefined;
  return {
    validated: r.validated === true,
    result: meta.TransactionResult ?? "unknown",
    account: String(tx.Account ?? ""),
    destination: String(tx.Destination ?? ""),
    ...(delivered ? { delivered } : {}),
    feeDrops: String(tx.Fee ?? ""),
  };
}

export type Check = { name: string; ok: boolean; detail: string };

export type RunFacts = {
  quote: Quote;
  expectNetwork: string;
  status: number;
  receipt?: { success: boolean; transaction: string; network: string; payer?: string | null };
  buyer: string;
  before: Snapshot;
  after: Snapshot;
  bodyText: string;
  originals: readonly string[];
  clientUnresolved: number;
  gatewayUnresolved?: string;
  answered: boolean;
  /** The payment looked up on the ledger by the receipt's transaction hash; absent when there was none or it was not found. */
  ledgerTx?: LedgerTx;
  /** The model the client named (--model); unset or chainaim/auto = the gateway picks, and no model check is added. */
  requestedModel?: string;
  /** x-chainaim-model and x-chainaim-zone from the gateway. */
  servedModel?: string;
  servedZone?: string;
};

/** Every check the run must pass; the run passes only when all do. */
export function verdict(f: RunFacts): Check[] {
  const checks = baseChecks(f);
  if (f.requestedModel && f.requestedModel !== "chainaim/auto") {
    checks.push({
      name: "served by the requested model",
      ok: f.servedModel === f.requestedModel,
      detail: f.servedModel ? `${f.servedModel} (zone ${f.servedZone ?? "not reported"}); requested ${f.requestedModel}` : `no model reported; requested ${f.requestedModel}`,
    });
  }
  return checks;
}

function baseChecks(f: RunFacts): Check[] {
  const price = unitsToDecimal(decimalUnits(f.quote.amount));
  const buyerDelta = rlusdDelta(f.before.buyerRlusd, f.after.buyerRlusd);
  const sellerDelta = rlusdDelta(f.before.sellerRlusd, f.after.sellerRlusd);
  const leaked = f.originals.filter((v) => v.length > 0 && f.bodyText.includes(v)).length;
  return [
    { name: "quote network", ok: f.quote.network === f.expectNetwork, detail: `${f.quote.network} (expected ${f.expectNetwork})` },
    { name: "nothing personal left this computer", ok: leaked === 0, detail: leaked === 0 ? "no original value in the request body" : `${leaked} original value(s) in the request body` },
    { name: "HTTP 200 with an answer", ok: f.status === 200 && f.answered, detail: `HTTP ${f.status}${f.answered ? "" : ", no answer"}` },
    { name: "payment settled", ok: f.receipt?.success === true && /^[0-9A-F]{64}$/.test(f.receipt.transaction), detail: f.receipt ? `success ${f.receipt.success}, transaction ${f.receipt.transaction}` : "no receipt" },
    { name: "payer is the buyer", ok: !f.receipt?.payer || f.receipt.payer === f.buyer, detail: `${f.receipt?.payer ?? "not stated"}` },
    { name: "buyer paid the price", ok: buyerDelta === `-${price}`, detail: `RLUSD ${buyerDelta} (expected -${price})` },
    { name: "seller received the price", ok: sellerDelta === `+${price}`, detail: `RLUSD ${sellerDelta} (expected +${price})` },
    ledgerCheck(f, price),
    feeCheck(f),
    { name: "every placeholder put back", ok: f.clientUnresolved === 0 && (f.gatewayUnresolved === undefined || f.gatewayUnresolved === "0"), detail: `this computer ${f.clientUnresolved}, gateway ${f.gatewayUnresolved ?? "not reported"}` },
  ];
}

/** The transaction itself: validated, tesSUCCESS, from the buyer, to the quoted pay-to, delivering exactly the quoted RLUSD. */
function ledgerCheck(f: RunFacts, price: string): Check {
  const t = f.ledgerTx;
  const name = "payment on the ledger";
  if (!t) return { name, ok: false, detail: "transaction not found on the ledger" };
  const problems: string[] = [];
  if (!t.validated) problems.push("not validated");
  if (t.result !== "tesSUCCESS") problems.push(`result ${t.result}`);
  if (t.account !== f.buyer) problems.push(`from ${t.account || "?"}, not the buyer`);
  if (t.destination !== f.quote.payTo) problems.push(`to ${t.destination || "?"}, not the seller`);
  const d = t.delivered;
  let deliveredOk = false;
  try {
    deliveredOk = !!d && d.currency === f.quote.asset && d.issuer === f.quote.issuer && decimalUnits(d.value) === decimalUnits(price);
  } catch {
    deliveredOk = false;
  }
  if (!deliveredOk) problems.push(d ? `delivered ${d.value} ${d.currency.slice(0, 8)}... from ${d.issuer}, expected ${price} RLUSD` : "delivered no RLUSD");
  return { name, ok: problems.length === 0, detail: problems.length === 0 ? `validated tesSUCCESS, ${f.buyer} -> ${t.destination}, delivered ${d!.value} RLUSD` : problems.join("; ") };
}

/** The buyer's XRP fell by exactly the transaction's fee (the price is paid in RLUSD, not XRP). */
function feeCheck(f: RunFacts): Check {
  const name = "buyer's XRP change is the fee";
  const t = f.ledgerTx;
  if (!t || !/^\d+$/.test(t.feeDrops) || !f.before.buyerDrops || !f.after.buyerDrops) return { name, ok: false, detail: "fee or balances unknown" };
  const spent = BigInt(f.before.buyerDrops) - BigInt(f.after.buyerDrops);
  return { name, ok: spent === BigInt(t.feeDrops), detail: `XRP -${spent} drops, fee ${t.feeDrops} drops` };
}
