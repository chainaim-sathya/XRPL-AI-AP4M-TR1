import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LedgerError, type LedgerRequest } from "../src/balance.ts";
import { AFTER_APPROVAL, payForChat, payWith, SIGN_TIMEOUT, type PayDeps, type PayNetwork } from "../src/pay.ts";
import { CANCELLED, NOT_SIGNED, type SignReply, type XrplTransaction } from "../src/crossmark-signer.ts";
import { NOT_ON_LEDGER } from "../src/xrpl-payment.ts";

const TESTNET = "xrpl:1";
const RLUSD = "524C555344000000000000000000000000000000";
const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const BUYER = "rN5gyNgd5AUh5pNkHfk17cN8QvZEdPKEk6";
const PAYTO = "rwaugYNb1VYhPVhV3oEa77Pa9itayatbJd";
const NET: PayNetwork = { name: "testnet", caip2: TESTNET, wsUrl: "ws://ledger.test", asset: RLUSD, issuer: ISSUER };
const CHAT_URL = "http://web.test/api/chat";
const SIGNED_BLOB = "1200002280000000";

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const OFFER = { scheme: "exact", network: TESTNET, amount: "0.01", asset: RLUSD, payTo: PAYTO, maxTimeoutSeconds: 600, extra: { issuer: ISSUER, invoiceId: "INVOICE-1", sourceTag: 804681468 } };
const REQUIRED = b64({ x402Version: 2, resource: { url: "http://web.test/api/chat" }, accepts: [OFFER] });
const ANSWER = JSON.stringify({ choices: [{ message: { content: "Hi <C_PERSON_1>" } }] });

/** The ledger readings a payment needs, so building it calls no node. */
const ledger: LedgerRequest = async (command) =>
  ({ account_info: { account_data: { Sequence: 5 } }, fee: { drops: { open_ledger_fee: "12" } }, ledger: { ledger_index: 1000 } })[command] as Record<string, unknown>;
const signedBy = (data: unknown): SignReply => ({ response: { data } }) as SignReply;

/** A stand-in /api/chat: 402 with the quote first, then `paid` for the request that carries a payment. */
function chatRoute(paid: (req: Request) => Response | Promise<Response>) {
  const seen: Request[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push(req);
    if (!req.headers.get("payment-signature")) return new Response("{}", { status: 402, headers: { "payment-required": REQUIRED } });
    return paid(req);
  }) as typeof fetch;
  return { seen, fetcher };
}

function deps(over: Partial<PayDeps> & { fetch: typeof fetch }): PayDeps {
  return { signAndWait: async () => signedBy({ txBlob: SIGNED_BLOB, meta: { isRejected: false } }), chatUrl: CHAT_URL, ledger, ...over };
}

const ask = (d: PayDeps) => payWith(d, BUYER, NET, "Hi <C_PERSON_1>");

describe("payWith", () => {
  it("ARCH-016 returns the answer with its receipt after Crossmark signs", async () => {
    const route = chatRoute(() => new Response(ANSWER, { headers: { "payment-response": b64({ success: true, transaction: "TX1", network: TESTNET }), "x-chainaim-model": "m:free" } }));
    let signedCalls = 0;
    const a = await ask(deps({ fetch: route.fetcher, onSigned: () => signedCalls++ }));
    assert.deepEqual(a, { answer: "Hi <C_PERSON_1>", model: "m:free", dataClass: null, payment: { transaction: "TX1", network: TESTNET } });
    assert.equal(signedCalls, 1);
    assert.equal(route.seen.length, 2);
    assert.deepEqual(JSON.parse(await route.seen[1].text()), { model: "chainaim/auto", messages: [{ role: "user", content: "Hi <C_PERSON_1>" }], max_tokens: 512 });
  });

  it("payForChat sends the console's whole conversation and picked model unchanged, both times, and pays once", async () => {
    const body = {
      model: "qwen/qwen2.5-3b",
      messages: [
        { role: "user", content: "data: a,b\nQ1" },
        { role: "assistant", content: "A1" },
        { role: "user", content: "Q2" },
      ],
    };
    const route = chatRoute(() => new Response(ANSWER, { headers: { "payment-response": b64({ success: true, transaction: "TX2", network: TESTNET }) } }));
    let signs = 0;
    const a = await payForChat(deps({ fetch: route.fetcher, chatUrl: "http://console.test/paid/chat", signAndWait: async () => (signs++, signedBy({ txBlob: SIGNED_BLOB })) }), BUYER, NET, body);
    assert.equal(signs, 1);
    assert.deepEqual(route.seen.map((r) => r.url), ["http://console.test/paid/chat", "http://console.test/paid/chat"]);
    for (const req of route.seen) assert.deepEqual(JSON.parse(await req.text()), body);
    assert.deepEqual(a, { answer: "Hi <C_PERSON_1>", model: null, dataClass: null, payment: { transaction: "TX2", network: TESTNET } });
  });

  it("ARCH-016 asks Crossmark to sign one RLUSD Payment for the quoted price, and sends it with the offer and the invoice", async () => {
    const route = chatRoute(() => new Response(ANSWER));
    const asked: XrplTransaction[] = [];
    await ask(deps({ fetch: route.fetcher, signAndWait: async (tx) => (asked.push(tx), signedBy({ txBlob: SIGNED_BLOB })) }));
    assert.equal(asked.length, 1);
    const amount = { currency: RLUSD, issuer: ISSUER, value: "0.01" };
    assert.deepEqual(
      [asked[0].TransactionType, asked[0].Account, asked[0].Destination, asked[0].Amount, asked[0].SendMax, asked[0].SourceTag, asked[0].Sequence, asked[0].Fee, asked[0].LastLedgerSequence],
      ["Payment", BUYER, PAYTO, amount, amount, 804681468, 5, "12", 1122],
    );
    assert.equal(route.seen[0].headers.get("payment-signature"), null, "the first request asks for the price");
    const payment = JSON.parse(Buffer.from(route.seen[1].headers.get("payment-signature")!, "base64").toString("utf8"));
    assert.deepEqual(payment, { x402Version: 2, accepted: OFFER, payload: { signedTxBlob: SIGNED_BLOB, invoiceId: "INVOICE-1" }, resource: { url: "http://web.test/api/chat" } });
  });

  it("ARCH-016 says cancelled when the Crossmark request is rejected", async () => {
    const route = chatRoute(() => new Response(ANSWER));
    const signAndWait = async () => signedBy({ txBlob: "", meta: { isRejected: true } });
    await assert.rejects(ask(deps({ fetch: route.fetcher, signAndWait })), { message: CANCELLED });
    assert.equal(route.seen.length, 1, "no paid request was sent");
  });

  it("ARCH-016 says Crossmark did not answer in time", async () => {
    const route = chatRoute(() => new Response(ANSWER));
    const never = () => new Promise<never>(() => {});
    await assert.rejects(ask(deps({ fetch: route.fetcher, signAndWait: never, signMs: 20 })), { message: SIGN_TIMEOUT });
    assert.equal(SIGN_TIMEOUT, "Crossmark did not answer in time. Nothing was paid.");
    assert.equal(route.seen.length, 1, "no paid request was sent");
  });

  it("ARCH-016 keeps 'Crossmark did not sign' (nothing paid) when Crossmark returns no signed transaction", async () => {
    const route = chatRoute(() => new Response(ANSWER));
    let signedCalls = 0;
    await assert.rejects(ask(deps({ fetch: route.fetcher, signAndWait: async () => signedBy({}), onSigned: () => signedCalls++ })), { message: NOT_SIGNED });
    assert.equal(signedCalls, 0);
    assert.equal(route.seen.length, 1, "no paid request was sent");
  });

  it("ARCH-016 says nothing was paid, and asks Crossmark for nothing, when the account is not on the ledger", async () => {
    const route = chatRoute(() => new Response(ANSWER));
    let asked = 0;
    const unfunded: LedgerRequest = async () => {
      throw new LedgerError("actNotFound", "Account not found.");
    };
    await assert.rejects(ask(deps({ fetch: route.fetcher, ledger: unfunded, signAndWait: async () => (asked++, signedBy({ txBlob: SIGNED_BLOB })) })), { message: NOT_ON_LEDGER });
    assert.equal(asked, 0);
    assert.equal(route.seen.length, 1);
  });

  it("ARCH-016 says nothing was paid when the price is quoted for another network", async () => {
    const route = chatRoute(() => new Response(ANSWER));
    await assert.rejects(payWith(deps({ fetch: route.fetcher }), BUYER, { ...NET, name: "mainnet", caip2: "xrpl:0" }, "Hi <C_PERSON_1>"), /^Error: The payment could not be made \(the price is not quoted for xrpl:0\)\. Nothing was paid\.$/);
    assert.equal(route.seen.length, 1);
  });

  it("warns to check the wallet when the connection fails after signing", async () => {
    const route = chatRoute(() => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(ask(deps({ fetch: route.fetcher })), { message: AFTER_APPROVAL });
  });

  it("never says 'not charged' for a server error after signing", async () => {
    for (const body of ["<html>oops</html>", JSON.stringify({ error: { message: "every model tried failed; you were not charged" } })]) {
      const route = chatRoute(() => new Response(body, { status: 500 }));
      const a = await ask(deps({ fetch: route.fetcher }));
      assert.deepEqual(a, { error: AFTER_APPROVAL, status: 500, transaction: null });
    }
  });

  it("passes on a server error message that already speaks of the payment, with the receipt", async () => {
    const message = "The answer was lost after your payment went through. Check your wallet's recent transactions before trying again.";
    const route = chatRoute(() => Response.json({ error: { message } }, { status: 502, headers: { "payment-response": b64({ success: true, transaction: "TX9", network: TESTNET }) } }));
    assert.deepEqual(await ask(deps({ fetch: route.fetcher })), { error: message, status: 502, transaction: "TX9" });
  });

  it("carries the receipt when a 5xx after signing is replaced by the wallet warning", async () => {
    const route = chatRoute(() => new Response("{}", { status: 503, headers: { "payment-response": b64({ success: true, transaction: "TX5", network: TESTNET }) } }));
    assert.deepEqual(await ask(deps({ fetch: route.fetcher })), { error: AFTER_APPROVAL, status: 503, transaction: "TX5" });
  });

  it("keeps 'not charged' when the paywall refuses the payment (402)", async () => {
    const route = chatRoute(() => new Response("{}", { status: 402 }));
    const a = await ask(deps({ fetch: route.fetcher }));
    assert.match((a as { error: string }).error, /You were not charged/);
  });

  it("shows the paywall's reason and the network when it refuses the payment", async () => {
    const refusal = () => new Response("{}", { status: 402, headers: { "payment-required": b64({ x402Version: 2, error: "invalid payment group", accepts: [] }) } });
    const a = (await ask(deps({ fetch: chatRoute(refusal).fetcher }))) as { error: string };
    assert.equal(a.error, "The payment was not accepted (invalid payment group). Check that your wallet holds RLUSD on TestNet and has a trust line for it. You were not charged.");
    const main = (await payWith(deps({ fetch: chatRoute(refusal).fetcher }), BUYER, { ...NET, name: "mainnet" }, "Hi <C_PERSON_1>")) as { error: string };
    assert.match(main.error, /holds RLUSD on MainNet and has a trust line/);
  });
});
