/**
 * The XRP Ledger side of one x402 payment (exact scheme): read the paywall's
 * price, build the RLUSD Payment the wallet signs, and wrap the signed
 * transaction in the PAYMENT-SIGNATURE header. No Node-only APIs and no ledger
 * library: the browser bundle uses this file, and test/xrpl-payment.test.ts
 * checks its output against the x402-xrpl SDK.
 */
import { LedgerError, type LedgerRequest } from "./balance.ts";
import type { XrplTransaction } from "./crossmark-signer.ts";

/** One entry of the paywall's accepts list. */
export type Offer = {
  scheme: string;
  network: string;
  /** A decimal string: "0.01" is one cent of RLUSD. */
  amount: string;
  /** The currency code. */
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: { issuer?: unknown; invoiceId?: unknown; sourceTag?: unknown; destinationTag?: unknown; [key: string]: unknown } | null;
};
export type PaymentRequired = { accepts: Offer[]; resource?: Record<string, unknown> };

/** The most this page lets a payment cost in network fee, in drops (0.01 XRP). */
export const MAX_FEE_DROPS = 10_000;
/** A ledger closes about every 5 seconds; two more ledgers allow for a slow one. */
const LEDGER_SECONDS = 5;
const LEDGER_SLACK = 2;

export const NOT_ON_LEDGER = "Your account is not on this network yet. Fund it with XRP and open its RLUSD trust line first. Nothing was paid.";
export const FEE_TOO_HIGH = "The XRP Ledger's fee is unusually high right now. Try again in a minute. Nothing was paid.";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
const isUint32 = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;

function base64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** JSON with every object's keys in sorted order, which is how the x402-xrpl SDK writes its headers. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = canonical((value as Record<string, unknown>)[key]);
  return out;
}

/** The PAYMENT-REQUIRED header: base64 JSON with the prices the paywall accepts. */
export function decodeRequired(header: string): PaymentRequired {
  const body = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(header), (c) => c.charCodeAt(0)))) as { accepts?: unknown; resource?: unknown };
  if (!Array.isArray(body.accepts)) throw new Error("the paywall's price is not in the expected shape");
  return { accepts: body.accepts as Offer[], resource: typeof body.resource === "object" && body.resource !== null ? (body.resource as Record<string, unknown>) : undefined };
}

function ledgerNumber(value: unknown, what: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`the XRP Ledger server's ${what} is not in the expected shape`);
  return n;
}

/**
 * The Payment for one offer, complete except for the signature: exactly the
 * quoted RLUSD amount to the pay-to account, bound to the offer's invoice both
 * ways the scheme allows (a memo and InvoiceID), with the sequence, fee and
 * last valid ledger filled in from the ledger.
 */
export async function preparePayment(account: string, offer: Offer, ledger: LedgerRequest): Promise<XrplTransaction> {
  const { issuer, invoiceId, sourceTag, destinationTag } = offer.extra ?? {};
  if (typeof issuer !== "string" || !issuer) throw new Error("the paywall's price names no RLUSD issuer");
  if (typeof invoiceId !== "string" || !invoiceId) throw new Error("the paywall's price names no invoice");
  if (typeof offer.amount !== "string" || !/^(0|[1-9]\d*)(\.\d+)?$/.test(offer.amount) || Number(offer.amount) <= 0) throw new Error("the paywall's price is not a positive decimal amount");
  if (sourceTag !== undefined && !isUint32(sourceTag)) throw new Error("the paywall's source tag is not a 32-bit number");
  if (destinationTag !== undefined && !isUint32(destinationTag)) throw new Error("the paywall's destination tag is not a 32-bit number");

  let info: Record<string, unknown>;
  try {
    info = await ledger("account_info", { account, ledger_index: "current" });
  } catch (e) {
    if (e instanceof LedgerError && e.code === "actNotFound") throw new Error(NOT_ON_LEDGER);
    throw e;
  }
  const sequence = ledgerNumber((info.account_data as { Sequence?: unknown } | undefined)?.Sequence, "account sequence");
  const fee = ledgerNumber(((await ledger("fee")).drops as { open_ledger_fee?: unknown } | undefined)?.open_ledger_fee, "fee");
  if (fee < 1 || fee > MAX_FEE_DROPS) throw new Error(FEE_TOO_HIGH);
  const validated = ledgerNumber((await ledger("ledger", { ledger_index: "validated" })).ledger_index, "ledger index");

  const amount = { currency: offer.asset, issuer, value: offer.amount };
  return {
    TransactionType: "Payment",
    Account: account,
    Destination: offer.payTo,
    Amount: amount,
    // The same amount: the payment may not spend more than the price, and is never partial.
    SendMax: amount,
    ...(sourceTag !== undefined ? { SourceTag: sourceTag } : {}),
    Memos: [{ Memo: { MemoData: hex(utf8(invoiceId)) } }],
    InvoiceID: hex(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(invoiceId)))),
    ...(destinationTag !== undefined ? { DestinationTag: destinationTag } : {}),
    Sequence: sequence,
    Fee: String(fee),
    LastLedgerSequence: validated + Math.ceil(offer.maxTimeoutSeconds / LEDGER_SECONDS) + LEDGER_SLACK,
  };
}

/** The PAYMENT-SIGNATURE header for a signed Payment: the offer it pays, the signed transaction and the invoice. */
export function paymentHeader(offer: Offer, signedTxBlob: string, resource?: Record<string, unknown>): string {
  const payload = { x402Version: 2, accepted: offer, payload: { signedTxBlob, invoiceId: offer.extra?.invoiceId }, ...(resource ? { resource } : {}) };
  return base64(utf8(JSON.stringify(canonical(payload))));
}

/** The PAYMENT-RESPONSE header: the receipt of a settled payment, or undefined when there is none. */
export function decodeReceipt(header: string | null): { transaction?: string; network?: string } | undefined {
  if (!header) return undefined;
  try {
    const receipt = JSON.parse(atob(header)) as { transaction?: unknown; network?: unknown };
    return {
      ...(typeof receipt.transaction === "string" && receipt.transaction ? { transaction: receipt.transaction } : {}),
      ...(typeof receipt.network === "string" ? { network: receipt.network } : {}),
    };
  } catch {
    return undefined; // an unreadable receipt is treated as none; the answer still shows
  }
}
