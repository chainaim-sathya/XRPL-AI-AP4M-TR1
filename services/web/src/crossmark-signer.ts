/**
 * Turns Crossmark's signAndWait into the signer the payment needs
 * ({ classicAddress, sign }). Crossmark itself is passed in, so this file has
 * no browser dependency: the tests run it with a fake, and wallet-entry.ts
 * passes the real Crossmark SDK. Crossmark signs and hands the signed
 * transaction back; it never submits it. The paywall's facilitator does that,
 * and only when the call is served.
 */
export type XrplTransaction = Record<string, unknown>;
/** What Crossmark's signAndWait resolves with, as far as this file reads it. */
export type SignReply = { response?: { data?: { txBlob?: unknown; meta?: { isRejected?: unknown } } } };
export type SignAndWait = (tx: XrplTransaction) => Promise<SignReply>;
export type XrplSigner = {
  classicAddress: string;
  sign(tx: XrplTransaction): Promise<{ signedTxBlob: string }>;
};

export const CANCELLED = "You cancelled the payment. Nothing was paid.";
export const NOT_SIGNED = "Crossmark did not sign the payment. Nothing was paid.";

export function crossmarkSigner(classicAddress: string, signAndWait: SignAndWait): XrplSigner {
  return {
    classicAddress,
    async sign(tx) {
      const data = (await signAndWait(tx))?.response?.data;
      if (data?.meta?.isRejected === true) throw new Error(CANCELLED);
      const blob = data?.txBlob;
      // A signed transaction is hex; anything else means nothing was signed.
      if (typeof blob !== "string" || !/^([0-9A-Fa-f]{2})+$/.test(blob)) throw new Error(NOT_SIGNED);
      return { signedTxBlob: blob.toUpperCase() };
    },
  };
}
