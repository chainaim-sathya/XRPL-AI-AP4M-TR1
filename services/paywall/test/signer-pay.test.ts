/**
 * scripts/signer.ts and payAndFetch (scripts/xrpl.ts) against a local paywall
 * with the stub facilitator and a stand-in for the XRP Ledger server: a
 * signer signs the prepared Payment, the payment is checked before it is
 * sent, and a price above the buyer's ceiling is refused before signing.
 * Nothing leaves the machine.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { decode, encode, verifySignature, Wallet } from "xrpl";
import { LedgerError, type LedgerRequest } from "../../web/src/balance.ts";
import { DEFAULT_RLUSD_CURRENCY_CODE, DEFAULT_RLUSD_ISSUER_TESTNET, NETWORKS } from "../src/config.ts";
import { seedSigner, type XrplSigner } from "../scripts/signer.ts";
import { account, decimalUnits, ledgerOverClient, payAndFetch, SetupError, seedBuyer, unitsToDecimal, type Buyer } from "../scripts/xrpl.ts";
import { close, listen, PAY_TO, startPaywall, stubFacilitator, stubGateway } from "./stubs.ts";

/** The answers an XRP Ledger TestNet server gives to the reads a payment needs. */
function ledger(networkId: number = 1): { request: LedgerRequest; seen: string[] } {
  const seen: string[] = [];
  const answers: Record<string, Record<string, unknown>> = {
    server_info: { info: { network_id: networkId } },
    account_info: { account_data: { Sequence: 41, Balance: "25000000" } },
    fee: { drops: { open_ledger_fee: "12" } },
    ledger: { ledger_index: 9_000_000 },
  };
  return {
    seen,
    request: async (command) => {
      seen.push(command);
      return answers[command];
    },
  };
}

const buyerWith = (signer: XrplSigner): Buyer => ({ networkName: "testnet", network: "xrpl:1", wsUrl: "wss://unused.example", signer });
const scan = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) };

describe("seedSigner (ARCH-016)", () => {
  it("ARCH-016 signs a transaction that verifies, from its own account", async () => {
    const wallet = Wallet.generate();
    const signer = seedSigner(wallet);
    const tx = { TransactionType: "Payment", Account: wallet.classicAddress, Destination: PAY_TO, Amount: "1000", Sequence: 1, Fee: "12", LastLedgerSequence: 10 };
    const { signedTxBlob } = await signer.sign(tx);
    assert.equal(decode(signedTxBlob).Account, wallet.classicAddress);
    assert.equal(verifySignature(signedTxBlob), true);
  });

  it("ARCH-011 exposes only the address and the sign function, never the seed", () => {
    const wallet = Wallet.generate();
    const signer = seedSigner(wallet);
    assert.deepEqual(Object.keys(signer).sort(), ["classicAddress", "sign"]);
    assert.ok(!JSON.stringify(signer).includes(wallet.seed!), "the seed is not on the signer");
  });
});

describe("account and seed prefixes (ARCH-011)", () => {
  it("ARCH-011 reads the seed from PREFIX_TESTNET when a prefix is given", () => {
    const wallet = Wallet.generate();
    const a = account({ XRPL_SEED_T01_TESTNET: wallet.seed }, { seedPrefix: "XRPL_SEED_T01" });
    assert.equal(a.wallet.classicAddress, wallet.classicAddress);
    assert.equal(seedBuyer(a).signer.classicAddress, wallet.classicAddress);
  });

  it("ARCH-011 names the missing variable for the prefix, and refuses a prefix that is not a variable name", () => {
    assert.throws(() => account({}, { seedPrefix: "XRPL_SEED_T02" }), (e: Error) => e instanceof SetupError && e.message.startsWith("XRPL_SEED_T02_TESTNET is required"));
    assert.throws(() => account({}, { seedPrefix: "bad-prefix" }), SetupError);
  });
});

describe("ledgerOverClient (ARCH-016)", () => {
  /** Stands in for an xrpl.js Client: answers or refuses requests as the real one does. */
  const fakeClient = (answer: (req: { command: string }) => unknown) => ({ request: async (req: { command: string }) => answer(req) }) as unknown as Parameters<typeof ledgerOverClient>[0];

  it("ARCH-016 sends each read as one request on the open connection and returns its result", async () => {
    const seen: unknown[] = [];
    const ledger = ledgerOverClient(fakeClient((req) => (seen.push(req), { result: { ledger_index: 7 } })));
    assert.deepEqual(await ledger("ledger", { ledger_index: "validated" }), { ledger_index: 7 });
    assert.deepEqual(seen, [{ command: "ledger", ledger_index: "validated" }]);
  });

  it("ARCH-016 keeps the server's error code, so an unfunded buyer is told to fund the account", async () => {
    const ledger = ledgerOverClient(
      fakeClient((req) => {
        if (req.command === "server_info") return { result: { info: { network_id: 1 } } };
        throw Object.assign(new Error("Account not found."), { data: { error: "actNotFound" } });
      }),
    );
    await assert.rejects(ledger("account_info", {}), (e: Error) => e instanceof LedgerError && e.code === "actNotFound");
    const wallet = Wallet.generate();
    const facilitator = stubFacilitator();
    const gateway = stubGateway();
    const pw = await startPaywall({ XRPL_PAY_TO_TESTNET: PAY_TO, GATEWAY_URL: await listen(gateway.server), CHAINAIM_GATEWAY_KEY: "test-key", FACILITATOR_URL_TESTNET: await listen(facilitator.server) });
    try {
      await assert.rejects(payAndFetch(`${pw.url}/v1/privacy/scan`, scan, buyerWith(seedSigner(wallet)), { ledger }), (e: Error) => e instanceof SetupError && e.message.includes(`${wallet.classicAddress} is not on testnet yet`));
    } finally {
      await pw.close();
      await close(facilitator.server);
      await close(gateway.server);
    }
  });

  it("ARCH-016 reports a lost connection as unreachable", async () => {
    const ledger = ledgerOverClient(
      fakeClient(() => {
        throw new Error("websocket was closed");
      }),
    );
    await assert.rejects(ledger("fee"), (e: Error) => e instanceof LedgerError && e.code === "unreachable" && /did not answer/.test(e.message));
  });
});

describe("decimal amounts (ARCH-004)", () => {
  it("ARCH-004 adds and compares RLUSD amounts exactly, as decimals", () => {
    assert.equal(unitsToDecimal(decimalUnits("0.1") + decimalUnits("0.2")), "0.3");
    assert.equal(unitsToDecimal(decimalUnits("0.2") - decimalUnits("0.01")), "0.19");
    assert.equal(unitsToDecimal(0n), "0");
    assert.throws(() => decimalUnits("1e-2"), SetupError);
    assert.throws(() => decimalUnits("-0.01"), SetupError);
  });
});

describe("payAndFetch through a signer (ARCH-016)", () => {
  const facilitator = stubFacilitator();
  const gateway = stubGateway();
  let paywall: { url: string; close: () => Promise<void> };
  before(async () => {
    paywall = await startPaywall({
      XRPL_PAY_TO_TESTNET: PAY_TO,
      GATEWAY_URL: await listen(gateway.server),
      CHAINAIM_GATEWAY_KEY: "test-key",
      FACILITATOR_URL_TESTNET: await listen(facilitator.server),
    });
  });
  after(async () => {
    await paywall.close();
    await close(facilitator.server);
    await close(gateway.server);
  });

  it("ARCH-016 pays the quoted RLUSD price with the signer's payment; the call is served and settled", async () => {
    const before = facilitator.calls.length;
    const l = ledger();
    const paid = await payAndFetch(`${paywall.url}/v1/privacy/scan`, scan, seedBuyer({ networkName: "testnet", network: "xrpl:1", wsUrl: "wss://unused.example", wallet: Wallet.generate() }), { ledger: l.request });
    assert.equal(paid.response.status, 200);
    assert.equal(paid.amount, "0.01");
    assert.equal(paid.receipt?.transaction, "TX-STUB-1");
    assert.deepEqual(facilitator.calls.slice(before).filter((c) => c !== "/supported"), ["/verify", "/settle"]);
    assert.deepEqual(l.seen, ["server_info", "account_info", "fee", "ledger"]);
  });

  it("ARCH-016 sends a Payment of exactly the quoted RLUSD amount, signed by the buyer, bound to the invoice", async () => {
    const wallet = Wallet.generate();
    let blob = "";
    const recording: XrplSigner = {
      classicAddress: wallet.classicAddress,
      async sign(tx) {
        blob = (await seedSigner(wallet).sign(tx)).signedTxBlob;
        return { signedTxBlob: blob };
      },
    };
    await payAndFetch(`${paywall.url}/v1/privacy/scan`, scan, buyerWith(recording), { ledger: ledger().request });
    const tx = decode(blob) as Record<string, unknown>;
    const amount = { currency: DEFAULT_RLUSD_CURRENCY_CODE, issuer: DEFAULT_RLUSD_ISSUER_TESTNET, value: "0.01" };
    assert.deepEqual(tx.Amount, amount);
    assert.deepEqual(tx.SendMax, amount);
    assert.equal(tx.Account, wallet.classicAddress);
    assert.equal(tx.Destination, PAY_TO);
    assert.equal(typeof tx.InvoiceID, "string");
    assert.equal((tx.Memos as unknown[]).length, 1);
  });

  it("ARCH-016 refuses a signer that changed the payment, before anything is presented", async () => {
    const wallet = Wallet.generate();
    const altering: XrplSigner = {
      classicAddress: wallet.classicAddress,
      sign: async (tx) => seedSigner(wallet).sign({ ...tx, Destination: Wallet.generate().classicAddress }),
    };
    const before = facilitator.calls.length;
    await assert.rejects(payAndFetch(`${paywall.url}/v1/privacy/scan`, scan, buyerWith(altering), { ledger: ledger().request }), (e: Error) => e instanceof SetupError && /changed the payment's Destination/.test(e.message));
    assert.ok(!facilitator.calls.slice(before).includes("/verify"), "nothing was presented for payment");
  });

  it("ARCH-016 refuses a payment whose signature does not verify", async () => {
    const wallet = Wallet.generate();
    const broken: XrplSigner = {
      classicAddress: wallet.classicAddress,
      async sign(tx) {
        const signed = decode((await seedSigner(wallet).sign(tx)).signedTxBlob) as Record<string, unknown>;
        const sig = String(signed.TxnSignature);
        signed.TxnSignature = `${sig.slice(0, -2)}${sig.endsWith("00") ? "01" : "00"}`;
        return { signedTxBlob: encode(signed as never) };
      },
    };
    const before = facilitator.calls.length;
    await assert.rejects(payAndFetch(`${paywall.url}/v1/privacy/scan`, scan, buyerWith(broken), { ledger: ledger().request }), /signature does not verify/);
    assert.ok(!facilitator.calls.slice(before).includes("/verify"));
  });

  it("ARCH-010 refuses a ledger server on another network, before preparing or signing", async () => {
    const l = ledger(0);
    let signed = false;
    const watching: XrplSigner = { classicAddress: Wallet.generate().classicAddress, sign: async () => ((signed = true), { signedTxBlob: "" }) };
    await assert.rejects(payAndFetch(`${paywall.url}/v1/privacy/scan`, scan, buyerWith(watching), { ledger: l.request }), /reports network 0, not xrpl:1/);
    assert.deepEqual(l.seen, ["server_info"]);
    assert.equal(signed, false);
  });

  it("ARCH-016 reports the facilitator's reason when the paywall refuses a presented payment", async () => {
    const refusing = createServer(async (req, res) => {
      for await (const _ of req);
      res.setHeader("content-type", "application/json");
      if (req.url === "/supported") res.end(JSON.stringify({ kinds: Object.values(NETWORKS).map((network) => ({ x402Version: 2, scheme: "exact", network })), extensions: [], signers: {} }));
      else if (req.url === "/verify") res.end(JSON.stringify({ isValid: false, invalidReason: "invalid_exact_xrpl_payload_fee", payer: "r" }));
      else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
    const ownGateway = stubGateway();
    const refusingPaywall = await startPaywall({ XRPL_PAY_TO_TESTNET: PAY_TO, GATEWAY_URL: await listen(ownGateway.server), CHAINAIM_GATEWAY_KEY: "test-key", FACILITATOR_URL_TESTNET: await listen(refusing) });
    try {
      const paid = await payAndFetch(`${refusingPaywall.url}/v1/privacy/scan`, scan, buyerWith(seedSigner(Wallet.generate())), { ledger: ledger().request });
      assert.equal(paid.response.status, 402);
      assert.equal(paid.refusal, "invalid_exact_xrpl_payload_fee");
      assert.equal(paid.receipt, undefined);
      assert.equal(ownGateway.seen.filter((s) => s.path === "/v1/privacy/scan").length, 0, "a refused payment is never served");
    } finally {
      await refusingPaywall.close();
      await close(refusing);
      await close(ownGateway.server);
    }
  });

  it("ARCH-004 refuses a price above the buyer's ceiling, before reading the ledger or signing", async () => {
    const l = ledger();
    let signed = false;
    const watching: XrplSigner = { classicAddress: Wallet.generate().classicAddress, sign: async () => ((signed = true), { signedTxBlob: "" }) };
    await assert.rejects(
      payAndFetch(`${paywall.url}/v1/privacy/scan`, scan, buyerWith(watching), { ledger: l.request, maxAmount: "0.009" }),
      /price 0.01 RLUSD is above the most this buyer may pay now \(0.009 RLUSD\)/,
    );
    assert.deepEqual(l.seen, []);
    assert.equal(signed, false);
  });
});
