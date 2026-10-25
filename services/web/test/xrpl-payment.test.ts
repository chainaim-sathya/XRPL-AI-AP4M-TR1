/**
 * The payment the browser builds, checked against the x402-xrpl SDK and
 * xrpl.js: the same invoice binding, the same header bytes, and a transaction
 * the ledger's own codec accepts. Nothing here calls a node or a facilitator.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decode, Wallet } from "xrpl";
import { buildPaymentSignatureHeaderForSignedBlob, decodePaymentRequiredHeader, decodePaymentSignatureHeader, invoiceIdToInvoiceIdField, invoiceIdToMemoHex } from "x402-xrpl";
import { LedgerError, type LedgerRequest } from "../src/balance.ts";
import { FEE_TOO_HIGH, MAX_FEE_DROPS, NOT_ON_LEDGER, decodeReceipt, decodeRequired, paymentHeader, preparePayment, type Offer } from "../src/xrpl-payment.ts";

const RLUSD = "524C555344000000000000000000000000000000";
const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const PAYTO = "rwaugYNb1VYhPVhV3oEa77Pa9itayatbJd";
const INVOICE = "96B9CE713055495CA9DA4E20663FDFAE";
/** A key made for these tests; it signs offline and is never funded. */
const BUYER = Wallet.generate();

const OFFER: Offer = {
  scheme: "exact",
  network: "xrpl:1",
  amount: "0.01",
  asset: RLUSD,
  payTo: PAYTO,
  maxTimeoutSeconds: 600,
  extra: { issuer: ISSUER, invoiceId: INVOICE, sourceTag: 804681468, areFeesSponsored: false },
};
const RESOURCE = { url: "https://pay.example.com/v1/chat/completions", description: "chat", mimeType: "application/json" };
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const REQUIRED = b64({ x402Version: 2, error: "Payment required", resource: RESOURCE, accepts: [OFFER], extensions: {} });

/** The ledger readings a payment needs, as an XRP Ledger server gives them. */
function ledger(over: Record<string, Record<string, unknown> | Error> = {}): { request: LedgerRequest; seen: [string, Record<string, unknown> | undefined][] } {
  const answers: Record<string, Record<string, unknown> | Error> = {
    account_info: { account_data: { Sequence: 41, Balance: "25000000" } },
    fee: { drops: { open_ledger_fee: "12", base_fee: "10" } },
    ledger: { ledger_index: 9_000_000 },
    ...over,
  };
  const seen: [string, Record<string, unknown> | undefined][] = [];
  const request: LedgerRequest = async (command, params) => {
    seen.push([command, params]);
    const answer = answers[command];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { request, seen };
}

describe("preparePayment (ARCH-016)", () => {
  it("ARCH-016 builds one RLUSD Payment for exactly the quoted amount, bound to the invoice", async () => {
    const l = ledger();
    const tx = await preparePayment(BUYER.classicAddress, OFFER, l.request);
    const amount = { currency: RLUSD, issuer: ISSUER, value: "0.01" };
    assert.deepEqual(tx, {
      TransactionType: "Payment",
      Account: BUYER.classicAddress,
      Destination: PAYTO,
      Amount: amount,
      SendMax: amount,
      SourceTag: 804681468,
      Memos: [{ Memo: { MemoData: invoiceIdToMemoHex(INVOICE) } }],
      InvoiceID: await invoiceIdToInvoiceIdField(INVOICE),
      Sequence: 41,
      Fee: "12",
      LastLedgerSequence: 9_000_000 + 120 + 2,
    });
    assert.deepEqual(l.seen, [
      ["account_info", { account: BUYER.classicAddress, ledger_index: "current" }],
      ["fee", undefined],
      ["ledger", { ledger_index: "validated" }],
    ]);
  });

  it("ARCH-004 puts the price in the transaction as the decimal it was quoted, not as micro-units", async () => {
    const tx = await preparePayment(BUYER.classicAddress, { ...OFFER, amount: "0.002" }, ledger().request);
    assert.equal((tx.Amount as { value: string }).value, "0.002");
    assert.equal((tx.SendMax as { value: string }).value, "0.002");
  });

  it("ARCH-016 is a transaction xrpl.js signs and the ledger's codec reads back unchanged", async () => {
    const tx = await preparePayment(BUYER.classicAddress, OFFER, ledger().request);
    const signed = BUYER.sign(tx as never);
    const read = decode(signed.tx_blob);
    for (const [field, value] of Object.entries(tx)) assert.deepEqual(read[field], value, field);
    assert.equal(read.SigningPubKey, BUYER.publicKey);
    assert.equal(read.Flags, undefined, "no partial-payment flag");
  });

  it("ARCH-016 adds a destination tag only when the price asks for one", async () => {
    const tagged = await preparePayment(BUYER.classicAddress, { ...OFFER, extra: { ...OFFER.extra, destinationTag: 7 } }, ledger().request);
    assert.equal(tagged.DestinationTag, 7);
    const plain = await preparePayment(BUYER.classicAddress, { ...OFFER, extra: { issuer: ISSUER, invoiceId: INVOICE } }, ledger().request);
    assert.equal("DestinationTag" in plain, false);
    assert.equal("SourceTag" in plain, false);
  });

  it("ARCH-016 says so when the account is not on the ledger", async () => {
    const l = ledger({ account_info: new LedgerError("actNotFound", "Account not found.") });
    await assert.rejects(preparePayment(BUYER.classicAddress, OFFER, l.request), { message: NOT_ON_LEDGER });
  });

  it("ARCH-016 refuses to sign a fee above the limit", async () => {
    const l = ledger({ fee: { drops: { open_ledger_fee: String(MAX_FEE_DROPS + 1) } } });
    await assert.rejects(preparePayment(BUYER.classicAddress, OFFER, l.request), { message: FEE_TOO_HIGH });
    const atLimit = await preparePayment(BUYER.classicAddress, OFFER, ledger({ fee: { drops: { open_ledger_fee: String(MAX_FEE_DROPS) } } }).request);
    assert.equal(atLimit.Fee, String(MAX_FEE_DROPS));
  });

  it("ARCH-016 refuses a price with no issuer, no invoice or an amount that is not a positive decimal, before reading the ledger", async () => {
    const bad: Offer[] = [
      { ...OFFER, extra: { invoiceId: INVOICE } },
      { ...OFFER, extra: { issuer: ISSUER } },
      { ...OFFER, extra: null },
      { ...OFFER, amount: "0" },
      { ...OFFER, amount: "1e-2" },
      { ...OFFER, amount: "-0.01" },
      { ...OFFER, amount: 10000 as never },
      { ...OFFER, extra: { ...OFFER.extra, sourceTag: -1 } },
    ];
    for (const offer of bad) {
      const l = ledger();
      await assert.rejects(preparePayment(BUYER.classicAddress, offer, l.request), /the paywall's/, JSON.stringify(offer));
      assert.deepEqual(l.seen, []);
    }
  });

  it("ARCH-016 passes a ledger failure on", async () => {
    const l = ledger({ ledger: new LedgerError("unreachable", "the XRP Ledger server did not answer") });
    await assert.rejects(preparePayment(BUYER.classicAddress, OFFER, l.request), /did not answer/);
  });
});

describe("paymentHeader (ARCH-016)", () => {
  it("ARCH-016 reads the paywall's price the way the x402-xrpl SDK does", () => {
    const mine = decodeRequired(REQUIRED);
    const sdk = decodePaymentRequiredHeader(REQUIRED);
    assert.deepEqual(mine.accepts, sdk.accepts);
    assert.deepEqual(mine.resource, RESOURCE);
  });

  it("ARCH-016 writes the same header, byte for byte, as the x402-xrpl SDK", async () => {
    const signed = BUYER.sign((await preparePayment(BUYER.classicAddress, OFFER, ledger().request)) as never).tx_blob;
    const sdkOffer = decodePaymentRequiredHeader(REQUIRED).accepts[0];
    const sdk = buildPaymentSignatureHeaderForSignedBlob({ req: sdkOffer, signedTxBlob: signed, invoiceId: INVOICE, resource: RESOURCE });
    assert.equal(paymentHeader(decodeRequired(REQUIRED).accepts[0], signed, RESOURCE), sdk);
    assert.equal(paymentHeader(OFFER, signed), buildPaymentSignatureHeaderForSignedBlob({ req: sdkOffer, signedTxBlob: signed, invoiceId: INVOICE }));
  });

  it("ARCH-016 carries the offer, the signed transaction and the invoice", () => {
    const payment = decodePaymentSignatureHeader(paymentHeader(OFFER, "12AB", RESOURCE));
    assert.equal(payment.x402Version, 2);
    assert.deepEqual(payment.accepted, OFFER);
    assert.deepEqual(payment.payload, { signedTxBlob: "12AB", invoiceId: INVOICE });
    assert.deepEqual(payment.resource, RESOURCE);
  });

  it("refuses a price header that has no list of prices", () => {
    assert.throws(() => decodeRequired(b64({ x402Version: 2 })), /not in the expected shape/);
  });
});

describe("decodeReceipt", () => {
  it("reads the transaction and network of a settled payment", () => {
    assert.deepEqual(decodeReceipt(b64({ success: true, transaction: "TX1", network: "xrpl:1", payer: "rBuyer" })), { transaction: "TX1", network: "xrpl:1" });
  });

  it("is undefined when there is no receipt or it cannot be read", () => {
    assert.equal(decodeReceipt(null), undefined);
    assert.equal(decodeReceipt("not base64 json"), undefined);
    assert.deepEqual(decodeReceipt(b64({ success: false })), {});
  });
});
