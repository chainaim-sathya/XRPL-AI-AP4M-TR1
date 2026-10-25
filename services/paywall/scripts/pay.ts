/**
 * Pay for one call to a deployed paywall route: x402, exact scheme, RLUSD on
 * the XRP Ledger. The buyer is the account whose family seed is in
 * XRPL_BUYER_SEED_TESTNET (or XRPL_BUYER_SEED_MAINNET when XRPL_NETWORK is
 * mainnet); use an account other than payTo. It needs a trust line to the
 * RLUSD issuer (scripts/trust-line.ts) and some RLUSD. --dry-run shows the
 * price and pays nothing.
 *
 * The body comes from exactly one of --text, --body-file or the positional
 * argument. Prefer the flags: a shell of its own may strip the quotes out of
 * JSON on the command line, or split it on its spaces, and the error that
 * follows names the JSON rather than the shell that broke it.
 *
 *   node scripts/pay.ts --dry-run https://PAYWALL/v1/privacy/scan
 *   node scripts/pay.ts https://PAYWALL/v1/privacy/mask --text "Patient Jane Roe, MRN 991122."
 *   node scripts/pay.ts https://PAYWALL/v1/chat/completions --body-file ask.json
 *   node scripts/pay.ts https://PAYWALL/v1/privacy/scan '{"text":"..."}'
 *
 * --seed-prefix NAME reads the seed from NAME_TESTNET (or NAME_MAINNET)
 * instead of XRPL_BUYER_SEED_*, so one of the test rig's tenants can pay:
 *
 *   node scripts/pay.ts --seed-prefix XRPL_SEED_T01 https://PAYWALL/v1/privacy/scan --text "hello"
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "dry-run": { type: "boolean", default: false },
    /** Scan and mask take { "text": ... }: this wraps the value, so no JSON reaches the shell. */
    text: { type: "string" },
    /** A file holding the whole JSON body, for a shape --text cannot build (chat, tool calls). */
    "body-file": { type: "string" },
    /** The seed is read from PREFIX_TESTNET or PREFIX_MAINNET. */
    "seed-prefix": { type: "string", default: "XRPL_BUYER_SEED" },
  },
});

const USAGE = "usage: node scripts/pay.ts [--dry-run] [--seed-prefix NAME] URL [--text TEXT | --body-file FILE | JSON_BODY]";

/** A problem with the arguments: print the message and exit with 2, as the other scripts do. */
function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function readBodyFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    fail(`cannot read ${path}: ${(e as Error).message}`);
  }
}

const [url, positionalBody] = positionals;
if (!url) fail(USAGE);

// One source of truth for the body: two would hide which one was sent.
const sources = [values.text !== undefined, values["body-file"] !== undefined, positionalBody !== undefined].filter(Boolean).length;
if (sources > 1) fail("give the body once: --text, --body-file or the positional argument, not more than one");

const body =
  values.text !== undefined
    ? JSON.stringify({ text: values.text })
    : values["body-file"] !== undefined
      ? readBodyFile(values["body-file"])
      : (positionalBody ?? "{}");

try {
  JSON.parse(body); // fail early on a malformed body
} catch (e) {
  const where = values["body-file"] !== undefined ? values["body-file"] : "the request body";
  fail(`${where} is not valid JSON: ${(e as Error).message}`);
}

const init = { method: "POST", headers: { "content-type": "application/json" }, body };

/** A 160-bit currency code such as RLUSD's reads as its letters; a three-letter code is shown as it is. */
const currencyName = (asset: unknown): string =>
  typeof asset === "string" && /^[0-9A-Fa-f]{40}$/.test(asset) ? Buffer.from(asset, "hex").toString("latin1").replace(/\0+$/, "") : String(asset);

if (values["dry-run"]) {
  const r = await fetch(url, init);
  const header = r.headers.get("payment-required");
  if (r.status !== 402 || !header) {
    console.log(`HTTP ${r.status}, no payment asked: ${(await r.text()).slice(0, 300)}`);
    process.exit(r.ok ? 0 : 1);
  }
  const required = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  for (const a of required.accepts) {
    // An issued-currency amount is already a decimal: 0.01 is one cent of RLUSD, never a count of micro-units.
    console.log(`price ${a.amount} ${currencyName(a.asset)} (asset ${a.asset}, issuer ${a.extra?.issuer ?? "none"}) on ${a.network} to ${a.payTo}; invoice=${a.extra?.invoiceId ?? "none"}`);
  }
  console.log(`resource ${required.resource?.url}; bazaar=${required.extensions?.bazaar ? "yes" : "no"}`);
  process.exit(0);
}

// Loaded only when paying, so --dry-run needs no signing libraries.
const { account, payAndFetch, seedBuyer, SetupError } = await import("./xrpl.ts");
try {
  const buyer = seedBuyer(account(process.env, { seedPrefix: values["seed-prefix"] }));
  console.log(`buyer ${buyer.signer.classicAddress} on ${buyer.network}`);
  const { response: r, receipt, refusal } = await payAndFetch(url, init, buyer);
  console.log(`HTTP ${r.status}`);
  if (refusal) console.log(`payment refused by the paywall: ${refusal}`);
  console.log((await r.text()).slice(0, 1000));
  if (r.ok) console.log(`payment ${JSON.stringify(receipt)}`);
  process.exitCode = r.ok ? 0 : 1;
} catch (e) {
  if (!(e instanceof SetupError)) throw e;
  console.error(e.message);
  process.exitCode = 2;
}
