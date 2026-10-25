/**
 * A tenant's buyer agent (L1): a Strands agent with one tool,
 * chainaim_private_ask. The command line is scripts/agent.ts; this file
 * holds the tool, the session it pays from, and the agent's construction,
 * so the tests can drive them in-process.
 *
 * What the agent's language model sees, and what it never sees:
 *
 *   sees   the user's prompt (masked on this machine when promptMask is on),
 *          the names of the files in the tenant's docs folder (aliases such
 *          as doc-1.txt when docAliases is on), the file and question it
 *          passes to the tool, and the tool's result: the payment's amount and
 *          transaction, plus ChainAim's answer with the placeholders
 *          (<C_PERSON_1>, ...) left in when answerToModel is "masked"; with
 *          answerToModel "none" (P13 pass-through) no answer text at all:
 *          the answer is shown on this machine only
 *   never  a document's text, the restore map, or an answer with the
 *          original values put back
 *
 * Prompt masking (scripts/prompt-scan.ts) runs this machine's pattern masker
 * (scripts/client-mask.ts) and, by default, the tenant's own Presidio on this
 * machine, which also catches a bare name in running text. With Presidio in
 * use and not answering, the prompt is refused and nothing is sent.
 *
 * The tool reads the document itself (plain text, PDF, Word, Excel or CSV:
 * scripts/extract.ts, F3), masks it on this machine
 * (scripts/private-ask-core.ts), pays the paywall in RLUSD and sends only the
 * masked text. The restored answer goes to `show`, which prints it on this
 * machine; it is not returned to the model. Anything the user types into the
 * prompt itself and this machine's masker does not catch reaches the model.
 *
 * Payments run one at a time per session: one XRP Ledger account numbers
 * its transactions, and the session's RLUSD ceiling is checked before each
 * payment is signed.
 */
import { realpathSync, readdirSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { Agent, tool, type Model } from "@strands-agents/sdk";
import { z } from "zod";
import { restore } from "./client-mask.ts";
import { DOC_TYPES, documentType, type DocType, type ExtractOptions } from "./extract.ts";
import { AskRefused, loadDocument, maskSummary, prepareAsk, refusalReason, sendAsk, type PayFn } from "./private-ask-core.ts";
import { PromptScan } from "./prompt-scan.ts";
import type { Timing } from "./timing.ts";
import { decimalUnits as units, SetupError, unitsToDecimal as decimal, type Buyer, type PayOptions } from "./xrpl.ts";

export const TOOL_NAME = "chainaim_private_ask";

/**
 * The path of `file` inside the docs folder, after following links. Refuses
 * anything outside it, so the model cannot have the tool read and send any
 * other file on this machine.
 */
export function resolveDocument(docsDir: string, file: string): string {
  let root: string;
  try {
    root = realpathSync(docsDir);
  } catch (e) {
    throw new AskRefused(`cannot open the docs folder ${docsDir}: ${(e as Error).message}`);
  }
  let real: string;
  try {
    real = realpathSync(resolve(root, file));
  } catch {
    throw new AskRefused(`no file "${file}" in the docs folder`);
  }
  const rel = relative(root, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new AskRefused(`"${file}" is outside the docs folder; only files in it can be asked about`);
  if (!statSync(real).isFile()) throw new AskRefused(`"${file}" is not a file`);
  return real;
}

/** The readable documents directly in the docs folder, by name: the types in `types` (every type scripts/extract.ts reads by default). */
export function listDocuments(docsDir: string, types: readonly DocType[] = DOC_TYPES): string[] {
  let names: string[];
  try {
    names = readdirSync(docsDir);
  } catch (e) {
    throw new AskRefused(`cannot read the docs folder ${docsDir}: ${(e as Error).message}`);
  }
  return names
    .filter((n) => {
      const type = documentType(n);
      return type !== undefined && types.includes(type) && statSync(join(docsDir, n)).isFile();
    })
    .sort();
}

/** One tool call, as shown on this machine. Holds the restored answer: never handed to the model. */
export type Shown = {
  file: string;
  question: string;
  status: "answered" | "dry_run" | "refused" | "failed";
  masked?: string;
  answerMasked?: string;
  answerRestored?: string;
  unresolved?: number;
  amount?: string;
  transaction?: string;
  reason?: string;
  /** What was read from the file ("2 pages", warnings such as pages with no text): shown on this machine only, never any of the text. */
  read?: string;
};

/** What the model receives from the tool. Never a document text or a restored value. */
export type ToolReply =
  | { status: "answered"; answer: string | null; note: string; paid: string | null; transaction: string | null; spent: string; remaining: string }
  | { status: "dry_run"; masked: string; characters: number; note: string }
  | { status: "refused"; reason: string; spent: string; remaining: string }
  | { status: "failed"; reason: string; httpStatus?: number; spent: string; remaining: string };

/**
 * What the agent's model receives of ChainAim's answer (P13).
 *   masked  the answer with ChainAim's placeholders kept (the old behaviour)
 *   none    no answer text: it is shown on this machine only, so the model provider never sees it
 */
export const ANSWER_TO_MODEL = ["masked", "none"] as const;
export type AnswerToModel = (typeof ANSWER_TO_MODEL)[number];

export type SessionOptions = {
  /** The tenant's docs folder; the tool reads only files inside it. */
  docsDir: string;
  /** The paywall's base address. Required unless dryRun. */
  base?: string;
  /** Who pays. Required unless dryRun. */
  buyer?: Buyer;
  /** The most RLUSD this session may spend. */
  maxSpend: string;
  /** Longest ChainAim answer, 1 to 1024. */
  maxTokens: number;
  /** Mask names found after a label. */
  names: boolean;
  /** Mask and report what would be sent; pay and send nothing. */
  dryRun: boolean;
  /** Called after every tool call with what to show on this machine. */
  show: (shown: Shown) => void;
  /** Ledger reads for payments; by default one connection per payment. */
  ledger?: PayOptions["ledger"];
  /** How payments are made; scripts/xrpl.ts payAndFetch by default. */
  pay?: PayFn;
  /** Mask the user's prompt on this machine before the agent's model sees it (maskPrompt). Off when unset. */
  promptMask?: boolean;
  /** How the prompt is masked when promptMask is on. Unset: client patterns only, with the residual check. */
  promptScan?: PromptScan;
  /** Records each tool call's phases (tool.total, tool.doc_mask, tool.<payment phase>) when set. */
  timing?: Timing;
  /** Show the model doc-1.txt, doc-2.md ... instead of the real file names (documentNames). Off when unset. */
  docAliases?: boolean;
  /**
   * false: ChainAim keeps its own placeholders in the answer (chainaim_restore: false), so a
   * value only the gateway caught never reaches the agent's model. Unset or true: the gateway
   * restores them before replying (the old behaviour).
   */
  serverRestore?: boolean;
  /** What the model gets of ChainAim's answer; "masked" when unset. */
  answerToModel?: AnswerToModel;
  /** How documents are read (F3: types, table format, size limits); scripts/extract.ts defaults when unset. */
  extract?: ExtractOptions;
};

const PLACEHOLDER_NOTE =
  "Values like <C_PERSON_1> or <PERSON_1> stand for personal details kept out of your view. Repeat them exactly as written; do not guess what they stand for.";

/** Given to the model instead of the answer when answerToModel is "none". */
export const PASS_THROUGH_NOTE =
  "ChainAim's answer has already been shown to the user on their own computer and is deliberately not given to you. Reply with one short sentence saying the answer is shown above. Do not describe, summarise or guess what it says.";

/**
 * One agent session's paying and asking. `ask` is the tool's body.
 */
export class AskSession {
  readonly options: SessionOptions;
  readonly ceiling: bigint;
  spent = 0n;
  calls = 0;
  /** Each answered call's restore map, kept on this machine to restore the agent's own reply for display. */
  private readonly maps: Record<string, string>[] = [];
  /** Tool calls run one after another, whatever order the agent issues them in. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Alias -> real file name, when docAliases is on; filled by documentNames. */
  private aliases = new Map<string, string>();

  constructor(options: SessionOptions) {
    this.options = options;
    this.ceiling = units(options.maxSpend);
    if (this.ceiling <= 0n) throw new AskRefused("--max-spend must be above 0");
    if (!options.dryRun && (!options.base || !options.buyer)) throw new AskRefused("a paying session needs the paywall's address and a buyer");
  }

  /**
   * The document names to give the agent's model: the real names, or aliases
   * (doc-1.txt, doc-2.md, in name order, extension kept) when docAliases is on.
   * Call it before the agent runs; with aliases on, the tool accepts only these.
   */
  documentNames(): string[] {
    const real = listDocuments(this.options.docsDir, this.options.extract?.types);
    if (!this.options.docAliases) return real;
    this.aliases = new Map(real.map((name, i) => [`doc-${i + 1}${extname(name).toLowerCase()}`, name]));
    return [...this.aliases.keys()];
  }

  /**
   * The one document the model may name, when exactly one is listed (the alias
   * when aliases are on); undefined when there are none or several. A tool call
   * without a file name uses it, so the agent never has to ask which file.
   */
  onlyDocument(): string | undefined {
    const names = this.options.docAliases ? [...this.aliases.keys()] : listDocuments(this.options.docsDir, this.options.extract?.types);
    return names.length === 1 ? names[0] : undefined;
  }

  /** The real file for a name the model passed. With aliases on, only an alias is accepted. */
  private realName(file: string): string {
    if (!this.options.docAliases) return file;
    const real = this.aliases.get(file);
    if (real === undefined) throw new AskRefused(`no document "${file}"; use one of the names listed`);
    return real;
  }

  /** How a file is named on this machine's screen: the alias and the real name when aliases are on. */
  private shownName(file: string): string {
    const real = this.options.docAliases ? this.aliases.get(file) : undefined;
    return real === undefined ? file : `${file} (${real})`;
  }

  /**
   * The prompt as the agent's model will see it. With promptMask on, it is
   * masked here by the session's PromptScan, self-checked, and its restore map
   * kept for restoreForDisplay; refused (AskRefused, nothing sent) when a
   * scanner fails or the masked text still holds a value that should be
   * masked. Unchanged when promptMask is off.
   */
  async maskPrompt(prompt: string): Promise<{ masked: string; counts: Record<string, number> }> {
    if (!this.options.promptMask) return { masked: prompt, counts: {} };
    const scan = this.options.promptScan ?? new PromptScan({ scanner: "client", names: this.options.names, residual: true });
    const { masked, map, counts } = await scan.mask(prompt);
    if (Object.keys(map).length > 0) this.maps.push(map);
    return { masked, counts };
  }

  spentDecimal(): string {
    return decimal(this.spent);
  }

  remaining(): string {
    return decimal(this.ceiling - this.spent);
  }

  ask(file: string, question: string): Promise<ToolReply> {
    const timing = this.options.timing;
    const run = this.queue.then(() => (timing ? timing.time("tool.total", () => this.askNow(file, question)) : this.askNow(file, question)));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async askNow(file: string, question: string): Promise<ToolReply> {
    this.calls++;
    const o = this.options;
    const money = (): { spent: string; remaining: string } => ({ spent: this.spentDecimal(), remaining: this.remaining() });
    let prepared;
    let read: string;
    let path: string | undefined;
    const shown = this.shownName(file);
    try {
      const reading = performance.now();
      path = resolveDocument(o.docsDir, this.realName(file));
      const document = await loadDocument(path, o.extract);
      read = [`${document.type}, ${document.detail}`, ...document.warnings].join("; ");
      o.timing?.add("tool.doc_read", performance.now() - reading);
      const masking = performance.now();
      prepared = prepareAsk({ document: document.text, endpoint: "chat", question, maxTokens: o.maxTokens, names: o.names, serverRestore: o.serverRestore });
      o.timing?.add("tool.doc_mask", performance.now() - masking);
    } catch (e) {
      if (!(e instanceof AskRefused)) throw e;
      // A refusal names the file by its path on this machine. The model is given the name it used
      // (an alias when aliases are on), so neither the real file name nor the folder reaches it.
      const named = (as: string): string => (path === undefined ? e.message : e.message.split(path).join(as));
      o.show({ file: shown, question, status: "refused", reason: named(shown) });
      return { status: "refused", reason: named(file), ...money() };
    }

    if (o.dryRun) {
      o.show({ file: shown, question, status: "dry_run", masked: prepared.masked, read });
      return { status: "dry_run", masked: maskSummary(prepared.counts) || "nothing found", characters: prepared.masked.length, note: "Dry run: nothing was sent to ChainAim and nothing was paid." };
    }

    let outcome;
    try {
      const onPhase = o.timing ? (phase: string, ms: number) => o.timing!.add(`tool.${phase}`, ms) : undefined;
      outcome = await sendAsk(o.base!, prepared, o.buyer!, { ledger: o.ledger, maxAmount: this.remaining(), pay: o.pay, onPhase });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      // A SetupError is raised before anything is paid: the ceiling, an unfunded account, the wrong network, a signer problem.
      const status = e instanceof SetupError ? "refused" : "failed";
      o.show({ file: shown, question, status, reason });
      return { status, reason, ...money() };
    }

    if (outcome.receipt?.success === true && outcome.amount !== undefined) this.spent += units(outcome.amount);
    if (!outcome.ok || outcome.answerMasked === undefined) {
      // The model is given ChainAim's own reason and whether anything was charged, so it has no gap to fill with a guess.
      const charged = outcome.receipt?.success === true;
      const detail = outcome.ok ? undefined : refusalReason(outcome.raw, { names: o.names });
      const base = outcome.refusal
        ? `refused by the paywall: ${outcome.refusal}`
        : outcome.ok
          ? "ChainAim's reply held no answer"
          : `HTTP ${outcome.status} from the paywall${detail ? `: ${detail}` : ""}`;
      const reason = charged ? base : `${base}; nothing was charged`;
      o.show({ file: shown, question, status: "failed", reason, ...(charged ? { amount: outcome.amount } : {}), transaction: outcome.receipt?.transaction });
      return { status: "failed", reason, httpStatus: outcome.status, ...money() };
    }

    this.maps.push(prepared.map);
    o.show({
      file: shown,
      question,
      read,
      status: "answered",
      answerMasked: outcome.answerMasked,
      answerRestored: outcome.answerRestored,
      unresolved: outcome.unresolved,
      amount: outcome.amount,
      transaction: outcome.receipt?.transaction,
    });
    const passThrough = o.answerToModel === "none";
    return {
      status: "answered",
      answer: passThrough ? null : outcome.answerMasked,
      note: passThrough ? PASS_THROUGH_NOTE : PLACEHOLDER_NOTE,
      paid: outcome.receipt?.success === true ? (outcome.amount ?? null) : null,
      transaction: outcome.receipt?.transaction ?? null,
      ...money(),
    };
  }

  /**
   * The agent's reply with this session's placeholders put back, for display
   * on this machine only. Each call masks its own document, so the same
   * placeholder can stand for different values in two calls: such a
   * placeholder is left as it is and counted as unresolved.
   */
  restoreForDisplay(text: string): { text: string; unresolved: number } {
    const merged: Record<string, string> = {};
    const clashing = new Set<string>();
    for (const map of this.maps) {
      for (const [key, value] of Object.entries(map)) {
        if (key in merged && merged[key] !== value) clashing.add(key);
        else merged[key] = value;
      }
    }
    for (const key of clashing) delete merged[key];
    return restore(text, merged);
  }
}

/**
 * The document a request is asked about directly, without the agent's model
 * (--direct-single-doc), or undefined when the model should decide. Direct
 * only when it is switched on, exactly one document is listed, and the answer
 * stays on this machine (answerToModel "none"): the model would then only
 * pick that one file and say "the answer is shown above", and on 2026-10-24
 * Nemotron twice asked which file instead. The user's request becomes the
 * tool's question and is masked together with the document by prepareAsk,
 * with one placeholder map; nothing goes to Bedrock. Call documentNames()
 * first when aliases are on.
 */
export function directDocument(session: AskSession, enabled: boolean): string | undefined {
  if (!enabled || session.options.answerToModel !== "none") return undefined;
  return session.onlyDocument();
}

/** The tool the agent calls. Its result is the session's ToolReply. */
export function askTool(session: AskSession) {
  const returns =
    session.options.answerToModel === "none"
      ? "shows ChainAim's answer to the user directly and returns only whether it was answered and paid. You never see the document or the answer."
      : "returns ChainAim's answer with the personal details still masked. You never see the document itself.";
  return tool({
    name: TOOL_NAME,
    description: `Ask ChainAim a question about one of the user's documents. The tool reads the document on the user's computer, masks personal details there, pays ChainAim in RLUSD on the XRP Ledger, and ${returns}`,
    inputSchema: z.object({
      file: z
        .string()
        .min(1)
        .optional()
        .describe("The document's file name, exactly as listed in the docs folder. May be left out when only one document is listed."),
      question: z
        .string()
        .min(1)
        .max(2000)
        .describe("What to ask about the document. Do not put personal details (names, numbers, e-mail addresses) in the question."),
    }),
    callback: (input): Promise<ToolReply> => {
      const file = input.file ?? session.onlyDocument();
      if (file === undefined) {
        return Promise.resolve({ status: "refused", reason: "several documents are listed; name one of them in file", spent: session.spentDecimal(), remaining: session.remaining() });
      }
      return session.ask(file, input.question);
    },
  });
}

/**
 * How the model is told to pick a document when it sees only aliases: the
 * alias carries no meaning, so a question about "my note" must still lead to
 * the one listed document, or to a question back when several are listed.
 */
export const ALIAS_NOTE =
  "These document names are neutral aliases that hide the real file names; they say nothing about what a document contains. When the user asks about a document in their own words (my note, the statement, my report) and only one document is listed, call the tool on that one. When several are listed and you cannot tell which one is meant, ask the user to choose from the list before calling the tool.";

/**
 * With one document listed, the model is told plainly that every question
 * about the user's note is about that file, so it calls the tool instead of
 * asking which file (Nemotron asked twice on 2026-10-24 with ALIAS_NOTE alone).
 */
export function singleDocumentNote(name: string): string {
  return `There is exactly one document, ${name}. Every question about the user's note, report, letter, record or document is about ${name}: call the tool on it straight away. Never ask the user which file, and never mention other file names.`;
}

/** The instructions the agent's model is given. Lists file names (or aliases) only. */
export function systemPrompt(tenantName: string, documents: readonly string[], aliased = false, answerToModel: AnswerToModel = "masked"): string {
  return [
    `You are the assistant of ${tenantName}. You answer questions about the user's documents using one tool, ${TOOL_NAME}.`,
    `Documents in the user's docs folder: ${documents.length > 0 ? documents.join(", ") : "(none)"}.`,
    ...(documents.length === 1 ? [singleDocumentNote(documents[0])] : []),
    ...(aliased ? [ALIAS_NOTE] : []),
    "You cannot read the documents yourself. To answer a question about one, call the tool with its file name and a question.",
    "Never ask the user to paste a document or its personal details into the chat.",
    "Keep questions to the tool free of personal details.",
    PLACEHOLDER_NOTE,
    ...(answerToModel === "none"
      ? [
          "You must call the tool for every question about a document; you have no other way to answer it. The tool shows ChainAim's answer to the user directly and gives you no answer text.",
          "Only after the tool has returned status answered in this conversation may you say the answer is shown above. Without that tool result, never say an answer was shown; call the tool instead.",
        ]
      : []),
    "Each tool call is paid. Call the tool only when the question needs a document, at most once per document unless the user asks again. If the tool refuses or fails, tell the user why and do not retry the same call.",
  ].join("\n");
}

export type AgentParts = { model: Model; session: AskSession; tenantName: string; documents: readonly string[]; aliased?: boolean };

/**
 * A Strands agent with the one tool. Tools run one at a time; the SDK's console printer is off, the caller prints.
 * The instructions follow the session's answerToModel, so the prompt and the tool's replies always agree.
 */
export function buildAgent(parts: AgentParts): Agent {
  return new Agent({
    model: parts.model,
    tools: [askTool(parts.session)],
    systemPrompt: systemPrompt(parts.tenantName, parts.documents, parts.aliased === true, parts.session.options.answerToModel ?? "masked"),
    toolExecutor: "sequential",
    printer: false,
  });
}
