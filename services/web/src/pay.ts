/**
 * One paid chat call: /api/chat answers with a price, Crossmark signs the
 * RLUSD payment for it, and the reply becomes an Answer or one plain sentence.
 * Crossmark and fetch are passed in, so this file has no browser dependency:
 * test/pay.test.ts drives it in Node, and wallet-entry.ts passes the real
 * Crossmark SDK and fetch.
 *
 * Money rule: once Crossmark has signed, a failure never says "not charged",
 * because the payment may have settled.
 */
import { readAnswer, type Answer, type Failure } from "./answer.ts";
import { ledgerOverWebSocket, type KnownNetwork, type LedgerRequest } from "./balance.ts";
import { CANCELLED, NOT_SIGNED, crossmarkSigner, type SignAndWait, type XrplSigner } from "./crossmark-signer.ts";
import { FEE_TOO_HIGH, NOT_ON_LEDGER, decodeReceipt, decodeRequired, paymentHeader, preparePayment } from "./xrpl-payment.ts";

export type PayNetwork = { name: KnownNetwork; caip2: string; wsUrl: string; asset: string; issuer: string };

export type PayDeps = {
  /** Crossmark's signAndWait, untimed: payWith adds the time limit. */
  signAndWait: SignAndWait;
  fetch: typeof fetch;
  /** Called once Crossmark has returned the signed payment. */
  onSigned?: () => void;
  /** The chat route; the browser uses the page-relative default. */
  chatUrl?: string;
  /** Sign time limit in ms (tests shorten it). */
  signMs?: number;
  /** For tests: the ledger reads the payment needs, so no node is called. */
  ledger?: LedgerRequest;
};

/** A Crossmark window the visitor never answers would wait for ever, so every Crossmark call has a time limit. */
const SIGN_MS = 180_000;
export const NO_CROSSMARK = "Crossmark was not found. Install the Crossmark extension, then reload this page.";
export const SIGN_TIMEOUT = "Crossmark did not answer in time. Nothing was paid.";
export const AFTER_APPROVAL = "The connection failed after you approved the payment. Check your wallet's recent transactions before trying again.";

export function within<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)));
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** The page's paid chat call: one masked user message. */
export function payWith(deps: PayDeps, address: string, net: PayNetwork, masked: string, maxTokens = 512): Promise<Answer | Failure> {
  return payForChat(deps, address, net, { model: "chainaim/auto", messages: [{ role: "user", content: masked }], max_tokens: maxTokens });
}

/**
 * One paid chat call with any body the paywall's chat route accepts: the test
 * console sends a whole conversation and the model it picked. The body goes out
 * unchanged, both to ask the price and with the payment.
 */
export async function payForChat(deps: PayDeps, address: string, net: PayNetwork, body: Record<string, unknown>): Promise<Answer | Failure> {
  const timeoutMessage = SIGN_TIMEOUT;
  let signed = false;
  const inner = crossmarkSigner(address, (tx) => within(deps.signAndWait(tx), deps.signMs ?? SIGN_MS, timeoutMessage));
  // Marked signed only after crossmarkSigner has checked that Crossmark returned a signed transaction.
  const signer: XrplSigner = {
    classicAddress: address,
    async sign(tx) {
      const out = await inner.sign(tx);
      signed = true;
      try {
        deps.onSigned?.();
      } catch {
        /* a status line must not break the payment */
      }
      return out;
    },
  };
  const ledger = deps.ledger ?? ledgerOverWebSocket(net.wsUrl);
  const ask = (payment?: string): Promise<Response> =>
    deps.fetch(deps.chatUrl ?? "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", ...(payment ? { "PAYMENT-SIGNATURE": payment } : {}) },
      body: JSON.stringify(body),
    });
  let r: Response;
  try {
    r = await ask();
    const quoted = r.status === 402 ? r.headers.get("payment-required") : null;
    if (quoted) {
      const required = decodeRequired(quoted);
      const offer = required.accepts.find((a) => a.scheme === "exact" && a.network === net.caip2);
      if (!offer) throw new Error(`the price is not quoted for ${net.caip2}`);
      const { signedTxBlob } = await signer.sign(await preparePayment(address, offer, ledger));
      r = await ask(paymentHeader(offer, signedTxBlob, required.resource));
    }
  } catch (e) {
    // The visitor sees one plain sentence; the console keeps the real error for debugging (it holds no text or keys).
    console.error("[privacybuddy] paid call failed", { signed, error: e });
    const m = String((e as Error)?.message ?? e);
    if (m.includes(CANCELLED)) throw new Error(CANCELLED);
    if (m.includes(timeoutMessage)) throw new Error(timeoutMessage);
    if (m.includes(NOT_SIGNED)) throw new Error(NOT_SIGNED);
    if (m.includes(NO_CROSSMARK)) throw new Error(NO_CROSSMARK);
    if (signed) throw new Error(AFTER_APPROVAL);
    if (m.includes(NOT_ON_LEDGER)) throw new Error(NOT_ON_LEDGER);
    if (m.includes(FEE_TOO_HIGH)) throw new Error(FEE_TOO_HIGH);
    throw new Error(`The payment could not be made (${m.slice(0, 200)}). Nothing was paid.`);
  }
  const settled = decodeReceipt(r.headers.get("payment-response"));
  const transaction = settled?.transaction ?? null;
  let text: string;
  try {
    text = await r.text();
  } catch (e) {
    console.error("[privacybuddy] reading the answer failed", { signed, status: r.status, error: e });
    if (signed) return { error: AFTER_APPROVAL, status: 502, transaction };
    throw new Error("The answer could not be read. Nothing was paid.");
  }
  const result = readAnswer(r.status, text, (name) => r.headers.get(name), settled, net.name);
  if (!("error" in result)) return result;
  if (signed && r.status >= 500 && /not charged/i.test(result.error)) return { error: AFTER_APPROVAL, status: r.status, transaction };
  // A failure that came with a receipt shows it, so the visitor can check the payment.
  return transaction && !result.transaction ? { ...result, transaction } : result;
}
