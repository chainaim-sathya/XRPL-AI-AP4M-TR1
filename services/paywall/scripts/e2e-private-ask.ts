/**
 * End-to-end paid private chat on TestNet, without a browser wallet, in one run:
 *   1. BEFORE  buyer and seller balances (XRP and RLUSD), the seller taken from the paywall's own quote
 *   2. WORK    mask the document on this computer, pay the quoted RLUSD over x402 with the buyer's
 *              seed, get the answer, put the values back on this computer
 *   3. AFTER   balances again, once the validated ledger shows the payment
 *   4. VERDICT every check, pass or fail; exit code 0 only when all pass
 * The seed is read from SEED_PREFIX_TESTNET, optionally loaded from --env-file; it is never
 * printed or saved. Only masked text leaves this computer. TestNet only.
 *
 *   node scripts/e2e-private-ask.ts --file ../../rig/tenants/t01/docs/supplier-dispute.txt \
 *     --env-file C:/PRIV-AI-SECRETS/testnet.env --seed-prefix XRPL_SEED_B01
 *
 * --file             the document (.txt or .md), read and masked here
 * --question         what to ask (default: explain the document)
 * --url              the paywall (default http://127.0.0.1:8080)
 * --seed-prefix      the buyer seed variable's prefix (default XRPL_BUYER_SEED)
 * --env-file         a .env-format file to read the seed from (kept outside the repository)
 * --max-amount       refuse, before signing, a price above this RLUSD amount (default 0.05)
 * --max-tokens       longest answer, 1 to 1024 (default 1024)
 * --settle-wait-sec  how long to wait for the validated ledger to show the payment (default 30)
 * --show-answer      print the restored answer (default on; --no-show-answer to hide it)
 * --model            chat model to ask for, e.g. hosted/nemotron-nano-reasoning (default chainaim/auto: the gateway picks);
 *                    when named, the VERDICT adds "served by the requested model" (with its zone)
 * --show-sent        print exactly what leaves this computer: the masked question and document (default on; --no-show-sent)
 */
import { parseArgs } from "node:util";
import { Client, dropsToXrp } from "xrpl";
import { formatLine, readAccountState } from "./balances-core.ts";
import { decodeQuote, E2ERefused, ledgerTxFrom, settledIn, verdict, type LedgerTx, type Snapshot } from "./e2e-core.ts";
import { AskRefused, DEFAULT_QUESTION, maskSummary, PATHS, prepareAsk, readDocument, sendAsk } from "./private-ask-core.ts";
import { account, DEFAULT_SEED_PREFIX, rlusd, seedBuyer, SetupError } from "./xrpl.ts";

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    question: { type: "string", default: DEFAULT_QUESTION },
    url: { type: "string", default: "http://127.0.0.1:8080" },
    "seed-prefix": { type: "string", default: DEFAULT_SEED_PREFIX },
    "env-file": { type: "string" },
    "max-amount": { type: "string", default: "0.05" },
    "max-tokens": { type: "string", default: "1024" },
    "settle-wait-sec": { type: "string", default: "30" },
    "show-answer": { type: "boolean", default: true },
    "show-sent": { type: "boolean", default: true },
    model: { type: "string", default: "chainaim/auto" },
  },
  allowNegative: true,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<number> {
  if (!values.file) throw new E2ERefused("--file is required (a .txt or .md document)");
  const base = values.url!.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base) || !URL.canParse(base)) throw new E2ERefused("--url must be the paywall's http(s) address");
  const waitSec = Number(values["settle-wait-sec"]);
  if (!Number.isInteger(waitSec) || waitSec < 0 || waitSec > 300) throw new E2ERefused("--settle-wait-sec must be a whole number from 0 to 300");
  if (values["env-file"]) {
    try {
      process.loadEnvFile(values["env-file"]);
    } catch (e) {
      throw new SetupError(`cannot read --env-file ${values["env-file"]}: ${(e as Error).message}`);
    }
  }
  const env = { ...process.env, XRPL_NETWORK: "testnet" };
  const who = account(env, { seedPrefix: values["seed-prefix"] });
  const token = rlusd(env);
  const buyer = who.wallet.classicAddress;

  // Read (not mask) the document now, so a bad file is refused before any network call; masking is part of WORK.
  const document = readDocument(values.file);

  // The seller is whoever the paywall's quote pays. The quote comes from an unpaid call with a neutral body:
  // the paywall answers 402 and forwards nothing, so no model runs and the document is not sent.
  const unpaid = await fetch(`${base}${PATHS.chat}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "price?" }] }), signal: AbortSignal.timeout(15_000) });
  if (unpaid.status !== 402) throw new E2ERefused(`the paywall answered HTTP ${unpaid.status} to an unpaid call, not 402 with a price`);
  const quote = decodeQuote(unpaid.headers.get("payment-required"));
  await unpaid.body?.cancel();
  const seller = quote.payTo;

  const client = new Client(who.wsUrl);
  await client.connect();
  try {
    const snap = async (): Promise<Snapshot & { lines: string[] }> => {
      const b = await readAccountState(client, buyer, token);
      const s = await readAccountState(client, seller, token);
      return { buyerRlusd: b.rlusd, sellerRlusd: s.rlusd, buyerDrops: b.drops, sellerDrops: s.drops, lines: [formatLine("buyer ", buyer, b), formatLine("seller", seller, s)] };
    };

    const before = await snap();
    console.log(`=== BEFORE === balances at ${new Date().toISOString()} (validated ledger)`);
    for (const l of before.lines) console.log(l);
    console.log(`price ${quote.amount} RLUSD on ${quote.network} to ${seller}`);

    console.log(`=== WORK === private chat, paid by ${buyer}; model ${values.model}`);
    const prepared = prepareAsk({ document, endpoint: "chat", question: values.question!, maxTokens: Number(values["max-tokens"]), names: true, model: values.model });
    const originals = Object.values(prepared.map);
    console.log(`read ${values.file} on this computer: ${document.length} characters; masked here, now: ${maskSummary(prepared.counts)}`);
    if (values["show-sent"]) {
      // Only the masked text is printed (placeholders, never an original value); the restore map stays in memory.
      const sent = (JSON.parse(prepared.bodyText) as { messages?: { content?: unknown }[] }).messages?.map((m) => String(m.content ?? "")).join("\n") ?? "";
      console.log("--- what leaves this computer (masked) ---");
      console.log(sent);
      console.log("--- end ---");
    }
    console.log(`sending ${Buffer.byteLength(prepared.bodyText)} bytes (masked only) to ${base}${PATHS.chat}`);
    const started = Date.now();
    const outcome = await sendAsk(base, prepared, seedBuyer(who), { maxAmount: values["max-amount"] });
    console.log(`HTTP ${outcome.status} after ${((Date.now() - started) / 1000).toFixed(1)} s`);
    for (const [name, value] of Object.entries(outcome.chainaimHeaders)) console.log(`${name}: ${value}`);
    if (outcome.refusal) console.log(`refused by the paywall: ${outcome.refusal}`);
    if (outcome.receipt) console.log(`payment success ${outcome.receipt.success}; transaction ${outcome.receipt.transaction}; https://testnet.xrpl.org/transactions/${outcome.receipt.transaction}`);
    if (values["show-answer"] && outcome.answerRestored !== undefined) {
      console.log("--- answer (values put back on this computer) ---");
      console.log(outcome.answerRestored);
      console.log("--- end ---");
    } else if (!outcome.ok) {
      console.log(outcome.raw ?? "");
    }

    let after = await snap();
    for (let waited = 0; outcome.receipt?.success && !settledIn(before, after, quote.amount) && waited < waitSec; waited += 2) {
      await sleep(2000);
      after = await snap();
    }
    console.log(`=== AFTER === balances at ${new Date().toISOString()} (validated ledger)`);
    for (const l of after.lines) console.log(l);
    const fee = before.buyerDrops && after.buyerDrops ? dropsToXrp((BigInt(before.buyerDrops) - BigInt(after.buyerDrops)).toString()) : "unknown";
    console.log(`buyer XRP spent on the network fee: ${fee}`);

    // The payment itself, from the validated ledger, by the receipt's transaction hash.
    let ledgerTx: LedgerTx | undefined;
    const hash = outcome.receipt?.transaction;
    if (hash && /^[0-9A-Fa-f]{64}$/.test(hash)) {
      for (let waited = 0; ; waited += 2) {
        try {
          const r = await client.request({ command: "tx", transaction: hash } as never);
          ledgerTx = ledgerTxFrom((r as { result: Record<string, unknown> }).result);
        } catch (e) {
          if ((e as { data?: { error?: string } })?.data?.error !== "txnNotFound") throw e;
        }
        if (ledgerTx?.validated || waited >= waitSec) break;
        await sleep(2000);
      }
      console.log(ledgerTx ? `ledger: ${hash} ${ledgerTx.validated ? "validated" : "not validated yet"}, ${ledgerTx.result}, ${ledgerTx.account} -> ${ledgerTx.destination}, delivered ${ledgerTx.delivered ? `${ledgerTx.delivered.value} RLUSD` : "no RLUSD"}, fee ${ledgerTx.feeDrops} drops` : `ledger: ${hash} not found`);
    }

    const checks = verdict({
      quote,
      expectNetwork: who.network,
      status: outcome.status,
      ...(outcome.receipt ? { receipt: outcome.receipt } : {}),
      buyer,
      before,
      after,
      bodyText: prepared.bodyText,
      originals,
      clientUnresolved: outcome.unresolved,
      ...(outcome.chainaimHeaders["x-chainaim-unresolved"] !== undefined ? { gatewayUnresolved: outcome.chainaimHeaders["x-chainaim-unresolved"] } : {}),
      answered: outcome.answerRestored !== undefined,
      ...(ledgerTx ? { ledgerTx } : {}),
      requestedModel: values.model,
      ...(outcome.chainaimHeaders["x-chainaim-model"] ? { servedModel: outcome.chainaimHeaders["x-chainaim-model"] } : {}),
      ...(outcome.chainaimHeaders["x-chainaim-zone"] ? { servedZone: outcome.chainaimHeaders["x-chainaim-zone"] } : {}),
    });
    console.log("=== VERDICT ===");
    for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
    const failed = checks.filter((c) => !c.ok).length;
    console.log(failed === 0 ? "END-TO-END PASSED" : `END-TO-END FAILED: ${failed} check(s)`);
    return failed === 0 ? 0 : 1;
  } finally {
    await client.disconnect();
  }
}

// process.exitCode, not process.exit(): exiting right after a network call crashes Node on Windows.
try {
  process.exitCode = await main();
} catch (e) {
  if (!(e instanceof E2ERefused) && !(e instanceof SetupError) && !(e instanceof AskRefused)) throw e;
  console.error(e.message);
  process.exitCode = 2;
}
