/**
 * Ask ChainAim about a document without sending its identifiers. The file is
 * read and masked on this machine (scripts/client-mask.ts); only the masked
 * text is paid for and sent; placeholders in the answer are put back here.
 * ChainAim's server scans the masked text again. The restore map never
 * leaves this process and is never written to disk. The logic is in
 * scripts/private-ask-core.ts, shared with the buyer agent (scripts/agent.ts).
 *
 *   node scripts/private-ask.ts --file prescription.txt --dry-run
 *   XRPL_BUYER_SEED_TESTNET="s..." node scripts/private-ask.ts --file prescription.txt --url https://PAYWALL [--endpoint chat|scan|mask]
 *
 * --endpoint      chat (default), scan or mask
 * --question      what to ask about the document (chat only)
 * --max-tokens    longest answer, 1 to 1024 (chat only, default 512)
 * --dry-run       mask and show what would be sent; send and pay nothing
 * --keep-masked   show the answer with the placeholders left in
 * --no-names      do not mask names found after a label
 * --seed-prefix   read the seed from NAME_TESTNET / NAME_MAINNET (default XRPL_BUYER_SEED)
 * --doc-types     which document types are read: all (default) or a list of txt,md,pdf,docx,xlsx,csv (F3)
 * --table-format  labelled (default) or grid: how Excel and CSV rows are written before masking.
 *                 labelled keeps each column header beside its value, which the gateway's date-of-birth
 *                 and account detectors need; grid is smaller but weakens that detection
 * --table-header  first-row (default) or none: whether a table's first row names its columns
 * --csv-delimiter one character between CSV fields (default ",")
 * --max-doc-mb    largest document read, in MB (default 20)
 * --model         chat model to ask for, e.g. hosted/nemotron-nano-reasoning (default chainaim/auto: the gateway picks)
 */
import { parseArgs } from "node:util";
import { parseDocTypes, TABLE_FORMATS, TABLE_HEADERS, type ExtractOptions, type TableFormat, type TableHeader } from "./extract.ts";
import { AskRefused, DEFAULT_QUESTION, isEndpoint, loadDocument, maskSummary, PATHS, prepareAsk, sendAsk, type PreparedAsk } from "./private-ask-core.ts";

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    url: { type: "string" },
    endpoint: { type: "string", default: "chat" },
    question: { type: "string", default: DEFAULT_QUESTION },
    "max-tokens": { type: "string", default: "512" },
    "dry-run": { type: "boolean", default: false },
    "keep-masked": { type: "boolean", default: false },
    "no-names": { type: "boolean", default: false },
    "seed-prefix": { type: "string", default: "XRPL_BUYER_SEED" },
    "doc-types": { type: "string", default: "all" },
    "table-format": { type: "string", default: "labelled" },
    "table-header": { type: "string", default: "first-row" },
    "csv-delimiter": { type: "string", default: "," },
    "max-doc-mb": { type: "string", default: "20" },
    model: { type: "string", default: "chainaim/auto" },
  },
});

function fail(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

const file = values.file ?? fail(2, "usage: node scripts/private-ask.ts --file DOCUMENT.txt [--url https://PAYWALL] [--endpoint chat|scan|mask] [--dry-run]");
const endpoint = values.endpoint;
if (!isEndpoint(endpoint)) fail(2, "--endpoint must be chat, scan or mask");
const dryRun = values["dry-run"] === true;
const base = values.url?.replace(/\/+$/, "");

const tableFormat = values["table-format"] as TableFormat;
if (!(TABLE_FORMATS as readonly string[]).includes(tableFormat)) fail(2, `--table-format must be one of ${TABLE_FORMATS.join(", ")}`);
const tableHeader = values["table-header"] as TableHeader;
if (!(TABLE_HEADERS as readonly string[]).includes(tableHeader)) fail(2, `--table-header must be one of ${TABLE_HEADERS.join(", ")}`);
const csvDelimiter = values["csv-delimiter"] === "\\t" ? "\t" : values["csv-delimiter"];
if (csvDelimiter.length !== 1 || csvDelimiter === '"') fail(2, "--csv-delimiter must be one character other than a quote (\\t for a tab)");
const maxDocMb = Number(values["max-doc-mb"]);
if (!(maxDocMb > 0 && maxDocMb <= 200)) fail(2, "--max-doc-mb must be a number above 0 and at most 200");
let extract: ExtractOptions;
try {
  extract = { types: parseDocTypes(values["doc-types"]), tableFormat, tableHeader, csvDelimiter, maxBytes: Math.floor(maxDocMb * 1024 * 1024) };
} catch (e) {
  fail(2, `--doc-types: ${(e as Error).message}`);
}

let document: string;
let readDetail = "";
let prepared: PreparedAsk;
try {
  const loaded = await loadDocument(file, extract);
  document = loaded.text;
  readDetail = [`${loaded.type}, ${loaded.detail}`, ...loaded.warnings].join("; ");
  if (!dryRun && (!base || !/^https?:\/\//.test(base) || !URL.canParse(base))) throw new AskRefused("--url is required and must be the paywall's http(s) address, e.g. https://PAYWALL");
  prepared = prepareAsk({ document, endpoint, question: values.question, maxTokens: Number(values["max-tokens"]), names: values["no-names"] !== true, model: values.model });
} catch (e) {
  if (!(e instanceof AskRefused)) throw e;
  fail(e.exitCode, e.message);
}

const summary = maskSummary(prepared.counts);
console.log(`read ${file} on this computer (${readDetail}): ${document.length} characters`);
console.log(`masked on this computer: ${summary || "nothing found"}${prepared.cardsRemoved > 0 ? ` (card numbers removed for good: ${prepared.cardsRemoved})` : ""}`);
console.log("--- what leaves this computer (masked) ---");
console.log(prepared.masked);
console.log("--- end ---");

if (dryRun) {
  console.log(`request body: ${prepared.bodyText}`);
  console.log("dry run: nothing was sent and nothing was paid");
  process.exit(0);
}

// Loaded only when paying, so --dry-run needs no signing libraries. Same buyer set-up as scripts/pay.ts.
const { account, seedBuyer, SetupError } = await import("./xrpl.ts");
let buyer;
try {
  buyer = seedBuyer(account(process.env, { seedPrefix: values["seed-prefix"] }));
} catch (e) {
  if (!(e instanceof SetupError)) throw e;
  fail(2, e.message);
}

console.log(`buyer ${buyer.signer.classicAddress}; sending ${prepared.bodyText.length} bytes to ${base}${PATHS[endpoint]}`);
const outcome = await sendAsk(base!, prepared, buyer);
console.log(`HTTP ${outcome.status}`);
for (const [name, value] of Object.entries(outcome.chainaimHeaders)) console.log(`${name}: ${value}`);

// process.exitCode, not process.exit(), after a network call: exiting right after one crashes Node on Windows.
if (!outcome.ok) {
  if (outcome.refusal) console.log(`refused by the paywall: ${outcome.refusal}`);
  console.log(outcome.raw ?? "");
  process.exitCode = 1;
} else if (endpoint === "chat") {
  if (outcome.answerMasked === undefined) {
    console.log(outcome.raw ?? JSON.stringify(outcome.result).slice(0, 1000));
  } else {
    const keep = values["keep-masked"] === true;
    console.log(keep ? "--- answer (placeholders kept) ---" : "--- answer (names put back on this computer) ---");
    console.log(keep ? outcome.answerMasked : outcome.answerRestored);
    console.log("--- end ---");
    if (!keep && outcome.unresolved > 0) console.log(`WARNING: ${outcome.unresolved} placeholder(s) in the answer could not be put back (the model changed or invented them); they are shown as they came`);
  }
  console.log(`payment ${JSON.stringify(outcome.receipt)}`);
} else {
  console.log(`--- ChainAim server's ${endpoint} of the masked text ---`);
  console.log(outcome.result === undefined ? (outcome.raw ?? "") : JSON.stringify(outcome.result, null, 2));
  console.log(`payment ${JSON.stringify(outcome.receipt)}`);
}
