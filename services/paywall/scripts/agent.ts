/**
 * A tenant's buyer agent (L1): a Strands agent on Amazon Bedrock with one tool,
 * chainaim_private_ask. Ask it about a document in the tenant's docs folder;
 * the tool masks the document on this computer, pays ChainAim in RLUSD from
 * the tenant's wallet, and sends only the masked text. The agent's model sees
 * the masked answer; this computer shows it with the real values put back.
 * Logic in scripts/agent-core.ts.
 *
 *   node scripts/agent.ts --tenant t02 --dry-run --prompt "What does my discharge note say about follow-up?"
 *   node scripts/agent.ts --tenant t02 --url http://127.0.0.1:8080 --prompt "..."
 *   node scripts/agent.ts --tenant t02 --url http://127.0.0.1:8080          (type questions; an empty line ends)
 *
 * --tenant            tenant id: a folder under --tenants (required)
 * --tenants           folder of tenant folders (default: rig/tenants at the repository root)
 * --docs              the tenant's documents (default: <tenants>/<tenant>/docs)
 * --url               the paywall's http(s) address (required unless --dry-run)
 * --prompt            one request to the agent; without it, requests are read line by line
 * --region            AWS region the Bedrock calls go to (default ap-southeast-2: the region the
 *                     ChainAim AWS free-plan project is limited to; Nemotron 3 Nano answered there on 2026-10-24)
 * --model-id          Bedrock model or inference profile id (default nvidia.nemotron-nano-3-30b: serverless,
 *                     tool calling checked through Converse on 2026-10-24, no Anthropic use-case form needed;
 *                     e.g. global.anthropic.claude-sonnet-4-6 needs that form and a region outside the free plan)
 * --prompt-mask       on|off: mask the typed prompt on this computer before Bedrock sees it (default on)
 * --prompt-scanner    client|presidio|both: what masks the prompt (default both). client = patterns only (names
 *                     only after a label); presidio = the tenant's own Presidio on this computer, which also
 *                     catches a bare name. With presidio in use and not answering, nothing is sent (fail closed)
 * --presidio-url      the tenant's Presidio analyzer (default http://127.0.0.1:5002: the "presidio" container)
 * --presidio-threshold  minimum entity score, 0 to 1 (default 0.4, as on the gateway)
 * --presidio-timeout-ms longest wait for one Presidio call, 100 to 120000 (default 5000)
 * --presidio-wait-ms  how long the start-up check waits for Presidio, 0 to 600000 (default 10000; 0 = one try)
 * --presidio-extra-entities  the gateway's --extra-entities groups: default|all|none|bank_account,titled_name,...
 *                     (default "default": everything but location)
 * --prompt-residual   on|off: refuse a masked prompt that still holds long digit runs, phone numbers,
 *                     e-mails or titled names (the gateway's residual check; default on)
 * --doc-aliases       on|off: show Bedrock doc-1.txt, doc-2.md ... instead of the real file names (default on)
 * --tenant-label      how the agent's instructions name the tenant (default "the user's organisation";
 *                     the tenant's real name is never sent unless you pass it here)
 * --server-restore    on|off: let ChainAim's gateway put its own placeholders back before replying (default off).
 *                     Off keeps any value the gateway caught but this computer missed out of what Bedrock sees;
 *                     such values then show as placeholders (e.g. <PERSON_1>) on this computer too
 * --answer-to-model   none|masked: what Bedrock gets of ChainAim's answer (default none). none = no answer
 *                     text: the answer is printed on this computer only and the agent just confirms it was
 *                     answered (P13 pass-through; the model provider never sees the answer). masked = the
 *                     answer with ChainAim's placeholders kept, so the agent can summarise it
 * --agent-max-tokens  longest reply from the agent's model, 1 to 8192 (default 1024)
 * --max-turns         most model calls per request, 1 to 20 (default 6)
 * --max-spend         the most RLUSD this session may pay ChainAim (default 0.05)
 * --max-tokens        longest ChainAim answer, 1 to 1024 (default 512)
 * --no-names          do not mask names found after a label
 * --show-masked       also print what left this computer and ChainAim's masked answer
 * --timing            off|on|json: print where each request's time went (default off). on = a table;
 *                     json = one line "timing {...}" per request, for collecting runs (p95). Names and
 *                     milliseconds only; the phases are listed in scripts/timing.ts
 * --ledger-prewarm    on|off: open the XRP Ledger connection at start-up, while Bedrock thinks, and reuse it for
 *                     every payment of the session (default on). off = one new connection inside each paid tool
 *                     call (the old behaviour; costs about 1.5 s per call, measured 2026-10-24). With it on,
 *                     tool.ledger_connect leaves the timing table; any connect still pending shows in ledger_network
 * --direct-single-doc on|off: with exactly one document listed and --answer-to-model none, ask ChainAim about it
 *                     directly and do not call Bedrock at all (default on). The request becomes the question and
 *                     is masked together with the document on this computer. Faster (no Bedrock turns) and the
 *                     model cannot skip the tool. off, several documents, or --answer-to-model masked: the model decides
 * --doc-types         which document types the tool reads: all (default) or a list of txt,md,pdf,docx,xlsx,csv (F3).
 *                     Images are always refused (no OCR); so are .doc/.xls (save as .docx/.xlsx)
 * --table-format      labelled|grid: how Excel and CSV rows are written before masking (default labelled).
 *                     labelled keeps each column header beside its value, which the gateway's date-of-birth
 *                     and account detectors need; grid is smaller but weakens that detection
 * --table-header      first-row|none: whether a table's first row names its columns (default first-row)
 * --csv-delimiter     one character between CSV fields (default ","; \t for a tab)
 * --max-doc-mb        largest document the tool reads, in MB (default 20)
 * --dry-run           mask and show what would be sent; pay and send nothing (Bedrock is still called)
 *
 * The tenant's seed is read from the variable its tenant.json names
 * (seedPrefix + _TESTNET or _MAINNET), as in the test rig, and never printed.
 * Bedrock credentials come from the AWS SDK's usual chain (AWS_PROFILE,
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, SSO); none is read here.
 * Exit code: 0 when every request was answered, 1 when the agent failed,
 * 2 for a set-up problem found before the agent ran.
 */
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { BedrockModel } from "@strands-agents/sdk";
import { ANSWER_TO_MODEL, AskSession, buildAgent, directDocument, listDocuments, TOOL_NAME, type AnswerToModel, type Shown } from "./agent-core.ts";
import { parseDocTypes, TABLE_FORMATS, TABLE_HEADERS, type ExtractOptions, type TableFormat, type TableHeader } from "./extract.ts";
import { AskRefused, maskSummary } from "./private-ask-core.ts";
import { presidioClient, PROMPT_SCANNERS, PromptScan, type PromptScanner } from "./prompt-scan.ts";
import { formatTiming, summarize, Timing } from "./timing.ts";
import { loadTenants } from "./rig-core.ts";
import { account, SetupError, seedBuyer, warmLedger, type Buyer, type WarmLedger } from "./xrpl.ts";

// The first statement after the imports: process start to here is Node start-up plus module loading.
const startupMs = performance.now();
const REPO = fileURLToPath(new URL("../../../", import.meta.url));

const { values } = parseArgs({
  options: {
    tenant: { type: "string" },
    tenants: { type: "string", default: join(REPO, "rig", "tenants") },
    docs: { type: "string" },
    url: { type: "string" },
    prompt: { type: "string" },
    region: { type: "string", default: "ap-southeast-2" },
    "model-id": { type: "string", default: "nvidia.nemotron-nano-3-30b" },
    "prompt-mask": { type: "string", default: "on" },
    "prompt-scanner": { type: "string", default: "both" },
    "presidio-url": { type: "string", default: "http://127.0.0.1:5002" },
    "presidio-threshold": { type: "string", default: "0.4" },
    "presidio-timeout-ms": { type: "string", default: "5000" },
    "presidio-wait-ms": { type: "string", default: "10000" },
    "presidio-extra-entities": { type: "string", default: "default" },
    "prompt-residual": { type: "string", default: "on" },
    timing: { type: "string", default: "off" },
    "doc-aliases": { type: "string", default: "on" },
    "tenant-label": { type: "string", default: "the user's organisation" },
    "server-restore": { type: "string", default: "off" },
    "answer-to-model": { type: "string", default: "none" },
    "agent-max-tokens": { type: "string", default: "1024" },
    "max-turns": { type: "string", default: "6" },
    "max-spend": { type: "string", default: "0.05" },
    "max-tokens": { type: "string", default: "512" },
    "no-names": { type: "boolean", default: false },
    "show-masked": { type: "boolean", default: false },
    "ledger-prewarm": { type: "string", default: "on" },
    "direct-single-doc": { type: "string", default: "on" },
    "doc-types": { type: "string", default: "all" },
    "table-format": { type: "string", default: "labelled" },
    "table-header": { type: "string", default: "first-row" },
    "csv-delimiter": { type: "string", default: "," },
    "max-doc-mb": { type: "string", default: "20" },
    "dry-run": { type: "boolean", default: false },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function whole(name: string, raw: string, min: number, max: number): number {
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < min || n > max) fail(`--${name} must be a whole number from ${min} to ${max}`);
  return n;
}

const tenantId = values.tenant ?? fail("usage: node scripts/agent.ts --tenant t01 [--url http://127.0.0.1:8080] [--prompt \"...\"] [--dry-run]");
const dryRun = values["dry-run"] === true;
const base = values.url?.replace(/\/+$/, "");
if (!dryRun && (!base || !/^https?:\/\//.test(base) || !URL.canParse(base))) fail("--url is required and must be the paywall's http(s) address, e.g. http://127.0.0.1:8080");
const agentMaxTokens = whole("agent-max-tokens", values["agent-max-tokens"], 1, 8192);
const maxTurns = whole("max-turns", values["max-turns"], 1, 20);
const maxTokens = whole("max-tokens", values["max-tokens"], 1, 1024);
const showMasked = values["show-masked"] === true;

function onOff(name: string, raw: string): boolean {
  if (raw !== "on" && raw !== "off") fail(`--${name} must be on or off`);
  return raw === "on";
}
const promptMask = onOff("prompt-mask", values["prompt-mask"]);
const docAliases = onOff("doc-aliases", values["doc-aliases"]);
const serverRestore = onOff("server-restore", values["server-restore"]);
const ledgerPrewarm = onOff("ledger-prewarm", values["ledger-prewarm"]) && !dryRun;
const directSingleDoc = onOff("direct-single-doc", values["direct-single-doc"]);
const answerToModel = values["answer-to-model"] as AnswerToModel;
if (!(ANSWER_TO_MODEL as readonly string[]).includes(answerToModel)) fail(`--answer-to-model must be one of ${ANSWER_TO_MODEL.join(", ")}`);
const tenantLabel = values["tenant-label"].trim();
if (tenantLabel === "") fail("--tenant-label must not be empty");

const tableFormat = values["table-format"] as TableFormat;
if (!(TABLE_FORMATS as readonly string[]).includes(tableFormat)) fail(`--table-format must be one of ${TABLE_FORMATS.join(", ")}`);
const tableHeader = values["table-header"] as TableHeader;
if (!(TABLE_HEADERS as readonly string[]).includes(tableHeader)) fail(`--table-header must be one of ${TABLE_HEADERS.join(", ")}`);
const csvDelimiter = values["csv-delimiter"] === "\\t" ? "\t" : values["csv-delimiter"];
if (csvDelimiter.length !== 1 || csvDelimiter === '"') fail("--csv-delimiter must be one character other than a quote (\\t for a tab)");
const maxDocMb = Number(values["max-doc-mb"]);
if (!(maxDocMb > 0 && maxDocMb <= 200)) fail("--max-doc-mb must be a number above 0 and at most 200");
let extract: ExtractOptions;
try {
  extract = { types: parseDocTypes(values["doc-types"]), tableFormat, tableHeader, csvDelimiter, maxBytes: Math.floor(maxDocMb * 1024 * 1024) };
} catch (e) {
  fail(`--doc-types: ${(e as Error).message}`);
}

const scanner = values["prompt-scanner"] as PromptScanner;
if (!(PROMPT_SCANNERS as readonly string[]).includes(scanner)) fail(`--prompt-scanner must be one of ${PROMPT_SCANNERS.join(", ")}`);
const presidioUrl = values["presidio-url"].replace(/\/+$/, "");
if (!/^https?:\/\//.test(presidioUrl) || !URL.canParse(presidioUrl)) fail("--presidio-url must be an http(s) address, e.g. http://127.0.0.1:5002");
const threshold = Number(values["presidio-threshold"]);
if (values["presidio-threshold"].trim() === "" || !(threshold >= 0 && threshold <= 1)) fail("--presidio-threshold must be a number from 0 to 1");
const presidioTimeoutMs = whole("presidio-timeout-ms", values["presidio-timeout-ms"], 100, 120000);
const presidioWaitMs = whole("presidio-wait-ms", values["presidio-wait-ms"], 0, 600000);
const promptResidual = onOff("prompt-residual", values["prompt-residual"]);
const timingMode = values.timing;
if (timingMode !== "off" && timingMode !== "on" && timingMode !== "json") fail("--timing must be off, on or json");
const timing = timingMode === "off" ? undefined : new Timing();
timing?.add("startup", startupMs);
let promptScan: PromptScan;
try {
  promptScan = new PromptScan({
    scanner,
    names: values["no-names"] !== true,
    residual: promptResidual,
    presidio: scanner === "client" ? undefined : presidioClient({ url: presidioUrl, threshold, timeoutMs: presidioTimeoutMs, extraEntities: values["presidio-extra-entities"] }),
  });
} catch (e) {
  fail(`--presidio-extra-entities: ${(e as Error).message}`);
}

function show(s: Shown): void {
  console.log(`[${TOOL_NAME}] ${s.file}: ${s.status}${s.amount ? `, ${s.amount} RLUSD` : ""}${s.transaction ? `, tx ${s.transaction}` : ""}${s.reason ? `: ${s.reason}` : ""}`);
  if (s.read) console.log(`  read on this computer: ${s.read}`);
  if (s.masked !== undefined && (showMasked || s.status === "dry_run")) {
    console.log("--- what would leave this computer (masked) ---");
    console.log(s.masked);
    console.log("--- end ---");
  }
  if (s.answerMasked !== undefined && showMasked) {
    console.log("--- ChainAim's answer as the agent sees it (placeholders kept) ---");
    console.log(s.answerMasked);
    console.log("--- end ---");
  }
  if (s.answerRestored !== undefined) {
    console.log("--- ChainAim's answer (names put back on this computer) ---");
    console.log(s.answerRestored);
    console.log("--- end ---");
    if (s.unresolved) console.log(`${s.unresolved} placeholder(s) in the answer were not ones this computer made, so they were left as they are`);
  }
}

let session: AskSession;
let tenantName: string;
let documents: string[];
let modelDocuments: string[];
let buyer: Buyer | undefined;
/** The pre-warmed ledger connection (--ledger-prewarm); opened only after set-up has passed, so a set-up failure exits with no connection in flight. */
let warm: WarmLedger | undefined;
const prewarmedLedger = ledgerPrewarm
  ? (command: string, params?: Record<string, unknown>) => {
      if (!warm) throw new SetupError("the XRP Ledger connection was not opened");
      return warm.ledger(command, params);
    }
  : undefined;
try {
  const [tenant] = loadTenants(values.tenants, [tenantId]);
  tenantName = tenant.name;
  const docsDir = values.docs ?? join(values.tenants, tenant.id, "docs");
  documents = listDocuments(docsDir, extract.types);
  if (documents.length === 0) throw new AskRefused(`no readable documents (${(extract.types ?? []).map((t) => `.${t}`).join(", ")}) in ${docsDir}`);
  if (!dryRun) buyer = seedBuyer(account(process.env, { seedPrefix: tenant.seedPrefix }));
  session = new AskSession({
    docsDir,
    base,
    buyer,
    maxSpend: values["max-spend"],
    maxTokens,
    names: values["no-names"] !== true,
    dryRun,
    show,
    promptMask,
    promptScan,
    timing,
    docAliases,
    serverRestore,
    answerToModel,
    extract,
    ...(prewarmedLedger ? { ledger: prewarmedLedger as NonNullable<WarmLedger["ledger"]> } : {}),
  });
  modelDocuments = session.documentNames();
} catch (e) {
  if (!(e instanceof SetupError) && !(e instanceof AskRefused)) throw e;
  fail(e.message);
}

// Set-up passed: open the ledger connection now, so it is ready by the first paid tool call.
if (ledgerPrewarm && buyer) warm = warmLedger(buyer.wsUrl);

// Start-up check of the prompt scanner: Presidio answers, has the entities ChainAim needs, and finds the test sentence.
// A failure here comes after a network call, so it sets process.exitCode and skips the run rather than calling process.exit().
let scannerProblem: string | undefined;
if (promptMask && promptScan.usesPresidio) {
  try {
    await (timing ? timing.time("presidio_check", () => promptScan.ready(presidioWaitMs)) : promptScan.ready(presidioWaitMs));
  } catch (e) {
    scannerProblem = e instanceof Error ? e.message : String(e);
  }
}

const model = new BedrockModel({ region: values.region, modelId: values["model-id"], maxTokens: agentMaxTokens });
// The model is given the label and the (aliased) document names, never the tenant's name or the real file names unless asked.
const agent = buildAgent({ model, session, tenantName: tenantLabel, documents: modelDocuments, aliased: docAliases });

/** One request, then its timing report when --timing is on or json. */
async function ask(prompt: string): Promise<boolean> {
  const ok = await askOnce(prompt);
  if (timing) {
    const summary = summarize(timing.take());
    if (timingMode === "json") console.log(`timing ${JSON.stringify({ ...summary, since_process_start: Math.round(performance.now()) })}`);
    else {
      console.log("--- timing (ms) ---");
      console.log(formatTiming(summary, performance.now()));
      console.log("--- end ---");
    }
  }
  return ok;
}

async function askOnce(prompt: string): Promise<boolean> {
  // One document and the answer kept here: ask ChainAim about it directly. The request is masked with the
  // document by the tool (one placeholder map); Bedrock is not called, so the prompt is not masked for it.
  const direct = directDocument(session, directSingleDoc);
  if (direct !== undefined) {
    const run = () => session.ask(direct, prompt);
    const reply = await (timing ? timing.time("agent_invoke", run) : run());
    return reply.status === "answered" || reply.status === "dry_run";
  }
  let sent: string;
  try {
    const { masked, counts } = await (timing ? timing.time("prompt_mask", () => session.maskPrompt(prompt)) : session.maskPrompt(prompt));
    sent = masked;
    const summary = maskSummary(counts);
    if (summary) console.log(`prompt: masked ${summary} on this computer before Bedrock`);
    if (showMasked && promptMask) {
      console.log("--- prompt as Bedrock sees it ---");
      console.log(sent);
      console.log("--- end ---");
    }
  } catch (e) {
    if (!(e instanceof AskRefused)) throw e;
    console.error(e.message);
    return false;
  }
  try {
    const callsBefore = session.calls;
    const run = () => agent.invoke(sent, { limits: { turns: maxTurns } });
    const result = await (timing ? timing.time("agent_invoke", run) : run());
    const reply = session.restoreForDisplay(result.toString());
    console.log("--- agent (names put back on this computer) ---");
    console.log(reply.text);
    console.log("--- end ---");
    if (reply.unresolved > 0) console.log(`${reply.unresolved} placeholder(s) in the reply could not be put back`);
    if (result.stopReason !== "endTurn") console.log(`the agent stopped: ${result.stopReason}`);
    // With --answer-to-model none the agent cannot see an answer, so a request with no tool call has none:
    // say so plainly instead of letting a reply such as "the answer is shown above" stand.
    if (answerToModel === "none" && session.calls === callsBefore) {
      console.error("the agent did not call ChainAim, so no answer was produced for this request (nothing paid); ask again or name the document");
      return false;
    }
    return true;
  } catch (e) {
    console.error(`the agent failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// process.exitCode, not process.exit(), after a network call: exiting right after one crashes Node on Windows.
if (scannerProblem !== undefined) {
  console.error(`the prompt scanner is not ready, so nothing was sent to Bedrock or ChainAim: ${scannerProblem}`);
  console.error(`start the tenant's Presidio (docker start presidio) and wait about a minute, or point --presidio-url at it`);
  process.exitCode = 2;
} else {
  console.log(`tenant ${tenantId} (${tenantName})${buyer ? `: payer ${buyer.signer.classicAddress} on ${buyer.network}` : ""}`);
  console.log(`model ${values["model-id"]} on Bedrock in ${values.region}; documents: ${documents.join(", ")}`);
  console.log(`sent to Bedrock: tenant as "${tenantLabel}"; documents as ${modelDocuments.join(", ")}; prompt masking ${promptMask ? `on (${promptScan.describe()}${promptResidual ? ", residual check" : ""})` : "off"}; ChainAim answers ${serverRestore ? "restored by the gateway" : "with the gateway's placeholders kept"}; ${answerToModel === "none" ? "answer text NOT sent to Bedrock (shown here only)" : "masked answer sent to Bedrock"}`);
  if (directDocument(session, directSingleDoc) !== undefined) {
    console.log(`direct: one document (${modelDocuments[0]}) and the answer stays here, so each request goes straight to ChainAim, masked with it; Bedrock is not called`);
  }
  console.log(dryRun ? "dry run: nothing will be sent to ChainAim or paid" : `paying ${base} at most ${values["max-spend"]} RLUSD this session; ledger connection ${ledgerPrewarm ? "opened at start-up and reused" : "opened per payment"}`);
  let allOk = true;
  if (values.prompt !== undefined) {
    allOk = await ask(values.prompt);
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    for (;;) {
      const line = (await rl.question("you> ")).trim();
      if (line === "") break;
      allOk = (await ask(line)) && allOk;
    }
    rl.close();
  }
  console.log(`session: ${session.calls} tool call(s), spent ${session.spentDecimal()} RLUSD`);
  process.exitCode = allOk ? 0 : 1;
}
await warm?.close();
