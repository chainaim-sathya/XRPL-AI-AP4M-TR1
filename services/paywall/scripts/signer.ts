/**
 * Who signs a buyer's payment. A signer is an address plus sign(tx), the same
 * shape the web page's Crossmark adapter has (services/web/src/crossmark-signer.ts).
 * payAndFetch (scripts/xrpl.ts) builds the Payment, asks the signer to sign
 * it, and checks the signed transaction before anything is sent, so another
 * kind of signer (a key held in AWS KMS, a hardware device) plugs in here with
 * no change to the payment code.
 *
 * seedSigner signs with an xrpl.js Wallet made from a family seed, for
 * development and the test rig. The returned object carries only the address
 * and the sign function: the seed is never printed, logged or exposed on it.
 */
import type { Wallet } from "xrpl";
import type { XrplSigner, XrplTransaction } from "../../web/src/crossmark-signer.ts";

export type { XrplSigner, XrplTransaction };

export function seedSigner(wallet: Wallet): XrplSigner {
  return {
    classicAddress: wallet.classicAddress,
    async sign(tx) {
      return { signedTxBlob: wallet.sign(tx as Parameters<Wallet["sign"]>[0]).tx_blob };
    },
  };
}
