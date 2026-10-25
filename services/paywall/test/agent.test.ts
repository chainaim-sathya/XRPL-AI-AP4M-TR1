/**
 * The buyer agent (L1, scripts/agent-core.ts) and the shared ask path
 * (scripts/private-ask-core.ts), in-process: a real paywall on a loopback port
 * with the stub facilitator, a gateway that answers chat, a stand-in for the
 * XRP Ledger server, and a scripted Strands model in place of Bedrock. The
 * scripted model records every message the agent loop hands it, so the tests
 * can check what a real model would have seen. Nothing leaves the machine.
 *
 * L1 has no ARCH-ID yet; the tests are named L1-AGENT, with the ARCH-ID of
 * the rule they also hold where there is one.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Model, type BaseModelConfig, type Message, type ModelStreamEvent } from "@strands-agents/sdk";
import { Wallet } from "xrpl";
import type { LedgerRequest } from "../../web/src/balance.ts";
import { AskSession, buildAgent, directDocument, listDocuments, PASS_THROUGH_NOTE, resolveDocument, singleDocumentNote, systemPrompt, TOOL_NAME, type Shown } from "../scripts/agent-core.ts";
import { AskRefused, prepareAsk, sendAsk } from "../scripts/private-ask-core.ts";
import { makePdf, makeXlsx } from "./fixtures/documents.ts";
import { seedSigner } from "../scripts/signer.ts";
import { Timing } from "../scripts/timing.ts";
import { payAndFetch, type Buyer } from "../scripts/xrpl.ts";
import { close, listen, PAY_TO, startPaywall, stubFacilitator } from "./stubs.ts";

const DOCUMENT = "Patient Name: Jane Roe\nMRN 991122\nAadhaar 2345 6789 0123\nE-mail jane.roe@example.com\nDiagnosis: diabetes. Rx: metformin 500 mg twice daily\n";
const ORIGINALS = ["Jane Roe", "991122", "2345 6789 0123", "jane.roe@example.com"];

function ledger(): LedgerRequest {
  const answers: Record<string, Record<string, unknown>> = {
    server_info: { info: { network_id: 1 } },
    account_info: { account_data: { Sequence: 41, Balance: "25000000" } },
    fee: { drops: { open_ledger_fee: "12" } },
    ledger: { ledger_index: 9_000_000 },
  };
  return async (command) => answers[command];
}

/** A gateway that answers chat by naming the first client placeholder it was sent, as a model working on masked text would. */
function chatGateway(): { server: Server; bodies: string[] } {
  const bodies: string[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("content-type", "application/json");
    const path = new URL(req.url ?? "/", "http://gateway.local").pathname;
    if (path === "/internal/capacity") return res.end(JSON.stringify({ chatAvailable: true }));
    if (path === "/healthz" || path === "/v1/models") return res.end(JSON.stringify({ status: "ok" }));
    bodies.push(body);
    const content = String(JSON.parse(body).messages?.[0]?.content ?? "");
    const person = content.match(/<C_PERSON_\d+>/)?.[0] ?? "the patient";
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `${person} should take metformin with meals.` } }] }));
  });
  return { server, bodies };
}

/**
 * A Strands model that plays a fixed script: first a call to the tool, then a
 * reply that quotes the tool's answer. Every message list it is given is kept.
 */
class ScriptedModel extends Model<BaseModelConfig> {
  readonly seen: Message[][] = [];
  private config: BaseModelConfig = { modelId: "scripted" };
  private readonly calls: { file: string; question: string }[];
  constructor(calls: { file: string; question: string }[]) {
    super();
    this.calls = calls;
  }
  updateConfig(c: BaseModelConfig): void {
    this.config = { ...this.config, ...c };
  }
  getConfig(): BaseModelConfig {
    return this.config;
  }
  async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.seen.push(structuredClone(messages));
    const turn = this.seen.length - 1;
    yield { type: "modelMessageStartEvent", role: "assistant" };
    if (turn < this.calls.length) {
      yield { type: "modelContentBlockStartEvent", start: { type: "toolUseStart", name: TOOL_NAME, toolUseId: `call-${turn}` } };
      yield { type: "modelContentBlockDeltaEvent", delta: { type: "toolUseInputDelta", input: JSON.stringify(this.calls[turn]) } };
      yield { type: "modelContentBlockStopEvent" };
      yield { type: "modelMessageStopEvent", stopReason: "toolUse" };
      return;
    }
    const answer = JSON.stringify(messages).match(/<C_PERSON_\d+>[^"\\]*/)?.[0] ?? "no answer";
    yield { type: "modelContentBlockStartEvent" };
    yield { type: "modelContentBlockDeltaEvent", delta: { type: "textDelta", text: `ChainAim says: ${answer}` } };
    yield { type: "modelContentBlockStopEvent" };
    yield { type: "modelMessageStopEvent", stopReason: "endTurn" };
  }
}

/** What a session reports as spent before any payment settles. */
const decimalZero = (s: AskSession): string => new AskSession({ ...s.options, dryRun: true }).spentDecimal();

const buyer = (): Buyer => ({ networkName: "testnet", network: "xrpl:1", wsUrl: "wss://unused.example", signer: seedSigner(Wallet.generate()) });

describe("L1 buyer agent", () => {
  const facilitator = stubFacilitator();
  const gateway = chatGateway();
  let paywall: { url: string; close: () => Promise<void> };
  let root: string;
  let docs: string;

  before(async () => {
    paywall = await startPaywall({
      XRPL_PAY_TO_TESTNET: PAY_TO,
      GATEWAY_URL: await listen(gateway.server),
      CHAINAIM_GATEWAY_KEY: "test-key",
      FACILITATOR_URL_TESTNET: await listen(facilitator.server),
    });
    root = mkdtempSync(join(tmpdir(), "agent-"));
    docs = join(root, "docs");
    mkdirSync(docs);
    writeFileSync(join(docs, "discharge.txt"), DOCUMENT);
    writeFileSync(join(docs, "notes.md"), "Name: Bob Stone\nAsk about the follow-up visit.\n");
    writeFileSync(join(docs, "image.png"), "not text");
    writeFileSync(join(root, "secret.txt"), "Name: Outside Person\n");
  });
  after(async () => {
    await paywall.close();
    await close(facilitator.server);
    await close(gateway.server);
    rmSync(root, { recursive: true, force: true });
  });

  const session = (extra: Partial<ConstructorParameters<typeof AskSession>[0]> = {}, shown: Shown[] = []) =>
    new AskSession({ docsDir: docs, base: paywall.url, buyer: buyer(), maxSpend: "0.05", maxTokens: 256, names: true, dryRun: false, show: (s) => shown.push(s), ledger: ledger(), ...extra });

  it("L1-AGENT ARCH-002 the agent pays and asks; only masked text reaches ChainAim and the model never sees an original value", async () => {
    const shown: Shown[] = [];
    const s = session({}, shown);
    const model = new ScriptedModel([{ file: "discharge.txt", question: "What should the patient know about the medicines?" }]);
    const agent = buildAgent({ model, session: s, tenantName: "Test Clinic", documents: listDocuments(docs) });
    const before = gateway.bodies.length;

    const result = await agent.invoke("Explain my discharge note.");

    // What left the machine: one masked chat body, paid once.
    const sent = gateway.bodies.slice(before);
    assert.equal(sent.length, 1);
    for (const v of ORIGINALS) assert.ok(!sent[0].includes(v), `${v} reached ChainAim`);
    assert.ok(sent[0].includes("<C_PERSON_1>") && sent[0].includes("metformin"));
    assert.equal(s.spentDecimal(), "0.01");
    assert.equal(s.remaining(), "0.04");

    // What the model saw, over every turn: no document text, no restored value.
    const seenByModel = JSON.stringify(model.seen);
    for (const v of ORIGINALS) assert.ok(!seenByModel.includes(v), `${v} was shown to the agent's model`);
    assert.ok(!seenByModel.includes("Bob Stone"), "another document's text was shown to the model");
    assert.ok(seenByModel.includes("<C_PERSON_1> should take metformin with meals."), "the model got ChainAim's masked answer");
    assert.ok(seenByModel.includes("TX-STUB-1"), "the model got the payment's transaction");

    // What this machine shows: the answer with the name put back.
    assert.equal(shown.length, 1);
    assert.equal(shown[0].status, "answered");
    assert.equal(shown[0].answerRestored, "Jane Roe should take metformin with meals.");
    assert.equal(shown[0].transaction, "TX-STUB-1");
    assert.equal(result.stopReason, "endTurn");
    assert.match(result.toString(), /<C_PERSON_1>/);
    assert.equal(s.restoreForDisplay(result.toString()).text, "ChainAim says: Jane Roe should take metformin with meals.");
  });

  it("L1-AGENT ARCH-003 the system prompt names the documents but holds none of their text", () => {
    const agent = buildAgent({ model: new ScriptedModel([]), session: session(), tenantName: "Test Clinic", documents: listDocuments(docs) });
    const prompt = JSON.stringify(agent.systemPrompt);
    assert.deepEqual(listDocuments(docs), ["discharge.txt", "notes.md"]);
    assert.ok(prompt.includes("discharge.txt, notes.md"));
    for (const v of [...ORIGINALS, "Bob Stone"]) assert.ok(!prompt.includes(v));
    assert.ok(prompt.includes("<C_PERSON_1>"), "the model is told how placeholders look");
  });

  it("L1-AGENT the tool reads only files inside the docs folder", async () => {
    assert.throws(() => resolveDocument(docs, "../secret.txt"), (e: Error) => e instanceof AskRefused && /outside the docs folder/.test(e.message));
    assert.throws(() => resolveDocument(docs, join(root, "secret.txt")), /outside the docs folder/);
    assert.throws(() => resolveDocument(docs, "missing.txt"), /no file "missing.txt"/);
    assert.throws(() => resolveDocument(docs, "."), /outside the docs folder/);
    // A directory junction: Windows makes one without admin rights (a file symlink needs them); elsewhere it is a plain directory link.
    symlinkSync(root, join(docs, "up"), "junction");
    try {
      assert.throws(() => resolveDocument(docs, join("up", "secret.txt")), /outside the docs folder/, "a link out of the folder is followed and refused");
    } finally {
      // unlink removes the link itself: rmSync calls a Windows junction a directory and refuses it.
      unlinkSync(join(docs, "up"));
    }
    const shown: Shown[] = [];
    const before = gateway.bodies.length;
    const reply = await session({}, shown).ask("../secret.txt", "What is this?");
    assert.equal(reply.status, "refused");
    assert.equal(gateway.bodies.length, before, "nothing was sent");
    assert.equal(shown[0].status, "refused");
  });

  it("L1-AGENT the tool refuses an image: there is no OCR, and nothing is sent", async () => {
    const before = gateway.bodies.length;
    const reply = await session().ask("image.png", "What is this?");
    assert.equal(reply.status, "refused");
    assert.match((reply as { reason: string }).reason, /is an image; ChainAim cannot read text in images \(there is no OCR\)/);
    assert.equal(gateway.bodies.length, before, "nothing was sent");
  });

  it("F3 the tool reads an Excel workbook, sends it masked, and the model sees none of its values", async () => {
    const sheets = join(root, "sheets");
    mkdirSync(sheets);
    writeFileSync(join(sheets, "patients.xlsx"), await makeXlsx());
    const shown: Shown[] = [];
    const s = session({ docsDir: sheets, docAliases: true }, shown);
    assert.deepEqual(s.documentNames(), ["doc-1.xlsx"]);
    const model = new ScriptedModel([{ file: "doc-1.xlsx", question: "Which patients have diabetes?" }]);
    const agent = buildAgent({ model, session: s, tenantName: "the user's organisation", documents: s.documentNames(), aliased: true });
    const before = gateway.bodies.length;
    await agent.invoke("Which of my patients have diabetes?");

    const sent = gateway.bodies.slice(before);
    assert.equal(sent.length, 1, "one paid call");
    // This machine masks the names, the labelled account number and the e-mail; the gateway masks dates of birth.
    for (const v of ["Ravi Kumar", "Lakshmi Iyer", "123456789012", "ravi.kumar@example.com"]) assert.ok(!sent[0].includes(v), `${v} reached ChainAim`);
    assert.ok(sent[0].includes("Diagnosis: Type 2 diabetes") && sent[0].includes("Date of birth:"), "the labels the gateway needs are kept");
    const seen = JSON.stringify(model.seen);
    for (const v of ["Ravi Kumar", "Lakshmi Iyer", "123456789012", "1975-06-02", "patients.xlsx"]) assert.ok(!seen.includes(v), `${v} reached the agent's model`);
    assert.equal(shown[0].status, "answered");
    assert.equal(shown[0].read, "xlsx, 2 sheets, 3 rows; 1 formula cell(s) had no saved result and were left empty (open and save the file in Excel to keep them)");
  });

  it("F3 a refused document is named to the model by its alias only: no real file name, no folder", async () => {
    const scans = join(root, "scans");
    mkdirSync(scans);
    writeFileSync(join(scans, "ravi-kumar-scan.pdf"), makePdf([[]]));
    const shown: Shown[] = [];
    const s = session({ docsDir: scans, docAliases: true }, shown);
    assert.deepEqual(s.documentNames(), ["doc-1.pdf"]);
    const reply = await s.ask("doc-1.pdf", "What does it say?");
    assert.equal(reply.status, "refused");
    const reason = (reply as { reason: string }).reason;
    assert.match(reason, /^doc-1\.pdf has no text layer/);
    assert.ok(!reason.includes("ravi-kumar") && !reason.includes(scans), `the model's reason names the real file: ${reason}`);
    assert.match(shown[0].reason ?? "", /^doc-1\.pdf \(ravi-kumar-scan\.pdf\) has no text layer/, "this machine shows both names");
  });

  it("L1-AGENT ARCH-004 the session's RLUSD ceiling is checked before signing; nothing is paid above it", async () => {
    const s = session({ maxSpend: "0.015" });
    const first = await s.ask("discharge.txt", "Summarise it.");
    assert.equal(first.status, "answered");
    const calls = facilitator.calls.length;
    const second = await s.ask("discharge.txt", "Summarise it again.");
    assert.equal(second.status, "refused");
    assert.match((second as { reason: string }).reason, /above the most this buyer may pay now \(0.005 RLUSD\)/);
    assert.ok(!facilitator.calls.slice(calls).includes("/verify"), "nothing was presented for payment");
    assert.equal(s.spentDecimal(), "0.01");
  });

  it("L1-AGENT a dry run masks and reports, and sends and pays nothing", async () => {
    const shown: Shown[] = [];
    const s = new AskSession({ docsDir: docs, maxSpend: "0.05", maxTokens: 256, names: true, dryRun: true, show: (x) => shown.push(x) });
    const before = gateway.bodies.length;
    const calls = facilitator.calls.length;
    const reply = await s.ask("discharge.txt", "Summarise it.");
    assert.equal(reply.status, "dry_run");
    assert.equal(gateway.bodies.length, before);
    assert.equal(facilitator.calls.length, calls);
    for (const v of ORIGINALS) assert.ok(!JSON.stringify(reply).includes(v));
    assert.ok(!JSON.stringify(reply).includes("metformin"), "the dry-run reply to the model holds counts, not the document");
    assert.ok(shown[0].masked?.includes("<C_PERSON_1>") && shown[0].masked.includes("metformin"), "this machine is shown what would leave it");
  });

  it("L1-AGENT ARCH-016 tool calls pay one at a time, even when the agent issues them together", async () => {
    let inFlight = 0;
    let most = 0;
    const pay: typeof payAndFetch = async (...args) => {
      inFlight++;
      most = Math.max(most, inFlight);
      try {
        return await payAndFetch(...args);
      } finally {
        inFlight--;
      }
    };
    const s = session({ pay });
    const replies = await Promise.all([s.ask("discharge.txt", "One?"), s.ask("notes.md", "Two?"), s.ask("discharge.txt", "Three?")]);
    assert.deepEqual(
      replies.map((r) => r.status),
      ["answered", "answered", "answered"],
    );
    assert.equal(most, 1);
    assert.equal(s.spentDecimal(), "0.03");
  });

  it("L1-AGENT a placeholder that stands for different values in two calls is not put back in the agent's reply", async () => {
    const s = session();
    await s.ask("discharge.txt", "One?");
    await s.ask("notes.md", "Two?");
    const r = s.restoreForDisplay("<C_PERSON_1> and <C_MEDICAL_RECORD_1>");
    assert.equal(r.text, "<C_PERSON_1> and 991122");
    assert.equal(r.unresolved, 1);
  });

  it("L1-AGENT a refusal reaches the model with ChainAim's own reason and says nothing was charged", async () => {
    const refused = (message: string): typeof payAndFetch => async () => ({
      response: new Response(JSON.stringify({ error: { message, type: "invalid_request_error", code: 422 } }), { status: 422, headers: { "content-type": "application/json" } }),
      amount: "0.01",
    });
    const shown: Shown[] = [];
    const s = session({ pay: refused("after masking, the request still holds 1 value(s) that look like personal data (titled_name 1); nothing was sent to a model and you were not charged.") }, shown);
    const reply = await s.ask("discharge.txt", "Summarise it.");
    assert.equal(reply.status, "failed");
    const reason = (reply as { reason: string }).reason;
    assert.match(reason, /HTTP 422 from the paywall: after masking/);
    assert.match(reason, /titled_name 1/);
    assert.match(reason, /; nothing was charged$/);
    assert.equal(s.spentDecimal(), decimalZero(s));
    assert.equal(shown[0].amount, undefined, "an unsettled price is not shown as paid");

    // A reason holding a value this machine would mask is dropped, not passed to the model.
    const leaky = await session({ pay: refused("no model for jane.roe@example.com") }).ask("discharge.txt", "Summarise it.");
    const leakyReason = (leaky as { reason: string }).reason;
    assert.ok(!leakyReason.includes("jane.roe@example.com"));
    assert.equal(leakyReason, "HTTP 422 from the paywall; nothing was charged");
  });

  it("L1-AGENT with promptMask on, the agent's model sees the typed prompt only masked, and this machine restores it", async () => {
    const prompt = "Patient Name: Jane Roe\nMRN 991122\nE-mail jane.roe@example.com\nWhat follow-up is needed?";
    const typed = ["Jane Roe", "991122", "jane.roe@example.com"];
    const s = session({ promptMask: true });
    const { masked, counts } = await s.maskPrompt(prompt);
    for (const v of typed) assert.ok(!masked.includes(v), `${v} is still in the masked prompt`);
    assert.ok(Object.keys(counts).length > 0);
    const model = new ScriptedModel([{ file: "discharge.txt", question: "What follow-up is needed?" }]);
    const agent = buildAgent({ model, session: s, tenantName: "the user's organisation", documents: s.documentNames() });
    await agent.invoke(masked);
    const seen = JSON.stringify(model.seen);
    for (const v of typed) assert.ok(!seen.includes(v), `${v} reached the agent's model`);
    const restored = s.restoreForDisplay(masked).text;
    for (const v of typed) assert.ok(restored.includes(v), `${v} was not put back on this machine`);
    // Off: the prompt goes as typed (the old behaviour).
    assert.equal((await session().maskPrompt(prompt)).masked, prompt);
  });

  it("L1-AGENT with docAliases on, the model sees doc-1.txt and doc-2.md, and the tool accepts only those names", async () => {
    const shown: Shown[] = [];
    const s = session({ docAliases: true }, shown);
    assert.deepEqual(s.documentNames(), ["doc-1.txt", "doc-2.md"]);
    const agent = buildAgent({ model: new ScriptedModel([]), session: s, tenantName: "the user's organisation", documents: s.documentNames(), aliased: true });
    const instructions = JSON.stringify(agent.systemPrompt);
    assert.ok(instructions.includes("doc-1.txt, doc-2.md"));
    assert.ok(instructions.includes("neutral aliases"), "the model is told how to pick a document by alias");
    const plain = JSON.stringify(buildAgent({ model: new ScriptedModel([]), session: session(), tenantName: "x", documents: ["a.txt"] }).systemPrompt);
    assert.ok(!plain.includes("neutral aliases"), "no alias note when names are real");
    assert.ok(!instructions.includes("discharge.txt") && !instructions.includes("notes.md"), "a real file name reached the model");
    const answered = await s.ask("doc-1.txt", "Summarise it.");
    assert.equal(answered.status, "answered");
    assert.equal(shown[0].file, "doc-1.txt (discharge.txt)", "this machine shows both names");
    const real = await s.ask("discharge.txt", "Summarise it.");
    assert.equal(real.status, "refused");
    assert.match((real as { reason: string }).reason, /no document "discharge.txt"/);
  });

  it("L1-AGENT with serverRestore off, ChainAim keeps its placeholders, so a value only the gateway caught never reaches the model", async () => {
    const bodies: string[] = [];
    // A gateway that masked a bare name this machine missed as <PERSON_1>; with its default restore it would put the name back.
    const gatewayLike: typeof payAndFetch = async (_url, init) => {
      bodies.push(init.body);
      const keep = JSON.parse(init.body).chainaim_restore === false;
      const content = keep ? "<PERSON_1> should come back in 2 weeks." : "Dana Hill should come back in 2 weeks.";
      return { response: new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }), amount: "0.01", receipt: { success: true, transaction: "TX-R", network: "xrpl:1" } };
    };
    const shown: Shown[] = [];
    const s = session({ pay: gatewayLike, serverRestore: false }, shown);
    const model = new ScriptedModel([{ file: "discharge.txt", question: "What follow-up?" }]);
    const agent = buildAgent({ model, session: s, tenantName: "the user's organisation", documents: s.documentNames() });
    await agent.invoke("What follow-up does my note mention?");
    assert.equal(JSON.parse(bodies[0]).chainaim_restore, false, "the tool asked ChainAim to keep its placeholders");
    const seen = JSON.stringify(model.seen);
    assert.ok(!seen.includes("Dana Hill"), "a value only the gateway caught reached the agent's model");
    assert.ok(seen.includes("<PERSON_1> should come back in 2 weeks."));
    assert.equal(shown[0].answerRestored, "<PERSON_1> should come back in 2 weeks.", "this machine cannot restore the gateway's placeholder, and does not guess");

    // Unset: the option is not sent (the old behaviour, still used by private-ask.ts).
    await session({ pay: gatewayLike }).ask("discharge.txt", "What follow-up?");
    assert.equal(JSON.parse(bodies[1]).chainaim_restore, undefined);
    // Never sent on scan or mask.
    assert.equal(JSON.parse(prepareAsk({ document: DOCUMENT, endpoint: "scan", serverRestore: false }).bodyText).chainaim_restore, undefined);
  });

  it("L1-AGENT with one document, the instructions say to use it without asking, and only then may a call leave the file out", () => {
    const single = join(root, "single");
    mkdirSync(single);
    writeFileSync(join(single, "discharge-note.txt"), DOCUMENT);
    const one = session({ docsDir: single, docAliases: true });
    assert.deepEqual(one.documentNames(), ["doc-1.txt"]);
    assert.equal(one.onlyDocument(), "doc-1.txt");
    const instructions = systemPrompt("the user's organisation", one.documentNames(), true);
    assert.ok(instructions.includes(singleDocumentNote("doc-1.txt")), "the single-document note is in the instructions");
    assert.ok(!instructions.includes("discharge-note.txt"), "the real name stays off the instructions");
    // Several documents: no single-document note, and no file is assumed.
    const two = session({ docAliases: true });
    two.documentNames();
    assert.equal(two.onlyDocument(), undefined);
    assert.ok(!systemPrompt("x", two.documentNames(), true).includes("There is exactly one document"));
  });

  it("P15 one document and the answer kept here: the request goes straight to ChainAim, masked with the document; otherwise the model decides", async () => {
    const dir = join(root, "direct");
    mkdirSync(dir);
    writeFileSync(join(dir, "discharge-note.txt"), DOCUMENT);
    const shown: Shown[] = [];
    const s = session({ docsDir: dir, docAliases: true, answerToModel: "none" }, shown);
    s.documentNames();
    assert.equal(directDocument(s, true), "doc-1.txt");
    assert.equal(directDocument(s, false), undefined, "switched off: the model decides");
    const masked = session({ docsDir: dir, docAliases: true, answerToModel: "masked" });
    masked.documentNames();
    assert.equal(directDocument(masked, true), undefined, "masked answers go to the model, so the model decides");
    const several = session({ answerToModel: "none" });
    several.documentNames();
    assert.equal(directDocument(several, true), undefined, "several documents: the model decides");

    // The request itself is the question; a name in it is masked with the document's own placeholders.
    const before = gateway.bodies.length;
    const reply = await s.ask(directDocument(s, true)!, "What should Jane Roe know about her medicines?");
    assert.equal(reply.status, "answered");
    const sent = gateway.bodies.slice(before);
    assert.equal(sent.length, 1, "one paid call");
    for (const v of ORIGINALS) assert.ok(!sent[0].includes(v), `${v} reached ChainAim`);
    assert.ok(JSON.parse(sent[0]).messages[0].content.startsWith("What should <C_PERSON_1> know about her medicines?"), "the question is masked with the document's map");
    assert.equal(shown[0].file, "doc-1.txt (discharge-note.txt)");
    assert.equal(shown[0].answerRestored, "Jane Roe should take metformin with meals.");
  });

  it("P13 with answerToModel none, ChainAim's answer is shown on this machine only and its text never reaches the agent's model", async () => {
    const shown: Shown[] = [];
    const s = session({ answerToModel: "none" }, shown);
    const model = new ScriptedModel([{ file: "discharge.txt", question: "What should the patient know about the medicines?" }]);
    const agent = buildAgent({ model, session: s, tenantName: "the user's organisation", documents: listDocuments(docs) });
    await agent.invoke("Explain my discharge note.");

    // Paid and answered as before; this machine shows the answer with the name put back.
    assert.equal(s.spentDecimal(), "0.01");
    assert.equal(shown[0].status, "answered");
    assert.equal(shown[0].answerRestored, "Jane Roe should take metformin with meals.");

    // The model saw no answer text over any turn: only the status, payment and the pass-through note.
    const seen = JSON.stringify(model.seen);
    assert.ok(!seen.includes("should take metformin with meals"), "ChainAim's answer reached the agent's model");
    assert.ok(shown[0].transaction && seen.includes(shown[0].transaction), "the model is told the call was paid");
    assert.ok(seen.includes("deliberately not given to you"), "the model is told why there is no answer");
    for (const v of ORIGINALS) assert.ok(!seen.includes(v));

    // The tool reply and the instructions agree.
    const reply = await s.ask("discharge.txt", "Again?");
    assert.equal(reply.status, "answered");
    assert.equal((reply as { answer: string | null }).answer, null);
    assert.equal((reply as { note: string }).note, PASS_THROUGH_NOTE);
    assert.match(JSON.stringify(agent.systemPrompt), /gives you no answer text/);

    // masked (and unset): the old behaviour, the masked answer goes to the model.
    const masked = await session({ answerToModel: "masked" }).ask("discharge.txt", "Again?");
    assert.equal((masked as { answer: string | null }).answer, "<C_PERSON_1> should take metformin with meals.");
    assert.ok(!systemPrompt("x", ["a.txt"]).includes("gives you no answer text"));
  });

  it("P14 with timing on, a paid tool call records each payment phase, names and milliseconds only", async () => {
    const timing = new Timing();
    const reply = await session({ timing }).ask("discharge.txt", "Summarise it.");
    assert.equal(reply.status, "answered");
    const phases = timing.take();
    const names = phases.map((p) => p.name);
    // The ledger is given here (one connection), so there is no tool.ledger_connect.
    assert.deepEqual(names, ["tool.doc_read", "tool.doc_mask", "tool.quote_402", "tool.ledger_network", "tool.ledger_prepare", "tool.sign", "tool.paid_call", "tool.total"]);
    for (const p of phases) assert.ok(Number.isFinite(p.ms) && p.ms >= 0, `${p.name} has a duration`);
    assert.deepEqual(Object.keys(phases[0]).sort(), ["ms", "name"], "a phase holds nothing but its name and duration");
  });

  it("L1-AGENT a session needs a positive ceiling, and a paywall and buyer unless it is a dry run", () => {
    assert.throws(() => session({ maxSpend: "0" }), /--max-spend must be above 0/);
    assert.throws(() => session({ buyer: undefined }), /needs the paywall's address and a buyer/);
  });
});

describe("L1 shared ask path (scripts/private-ask-core.ts)", () => {
  it("L1-AGENT ARCH-003 sendAsk returns ChainAim's answer masked and restored; only the masked body is sent", async () => {
    const prepared = prepareAsk({ document: DOCUMENT, endpoint: "chat", question: "Is Jane Roe on two drugs?" });
    assert.ok(prepared.masked.startsWith("Is <C_PERSON_1> on two drugs?"), "the question is masked with the document");
    let body = "";
    const pay: typeof payAndFetch = async (_url, init) => {
      body = init.body;
      const answer = { choices: [{ message: { content: "<C_PERSON_1> is on one drug. <C_OTHER_9> unknown." } }] };
      return { response: new Response(JSON.stringify(answer), { status: 200, headers: { "x-chainaim-decision-id": "d-1" } }), amount: "0.01", receipt: { success: true, transaction: "TX-1", network: "xrpl:1" } };
    };
    const outcome = await sendAsk("http://paywall.invalid", prepared, buyer(), { pay });
    for (const v of ORIGINALS) assert.ok(!body.includes(v));
    assert.equal(outcome.url, "http://paywall.invalid/v1/chat/completions");
    assert.equal(outcome.answerMasked, "<C_PERSON_1> is on one drug. <C_OTHER_9> unknown.");
    assert.equal(outcome.answerRestored, "Jane Roe is on one drug. <C_OTHER_9> unknown.");
    assert.equal(outcome.unresolved, 1);
    assert.deepEqual(outcome.chainaimHeaders, { "x-chainaim-decision-id": "d-1" });
    assert.equal(outcome.receipt?.transaction, "TX-1");
  });

  it("L1-AGENT prepareAsk refuses a body too long for the endpoint, and bad max-tokens", () => {
    assert.throws(() => prepareAsk({ document: "a".repeat(20_001), endpoint: "scan" }), (e: Error) => e instanceof AskRefused && e.exitCode === 2 && /scan takes at most 20000/.test(e.message));
    assert.throws(() => prepareAsk({ document: DOCUMENT, endpoint: "chat", maxTokens: 0 }), /--max-tokens must be a whole number from 1 to 1024/);
  });
});
