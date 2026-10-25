/**
 * Rig R5 (Bedrock): PASS/FAIL per model before ChainAim builds on it.
 *
 *   converse  one short Converse call: does the model answer at all?
 *   tool      one Converse call with a tool shaped like chainaim_private_ask: does it return a tool call?
 *   openai    the same short prompt through an OpenAI-compatible Chat Completions endpoint with a
 *             Bedrock API key (Bearer): can the gateway's catalog mode reach this model? With the
 *             provider-field check on, the request is sent again with the OpenRouter field the
 *             gateway's dispatch.ts always adds ({ provider: { data_collection } }).
 *
 * The Converse call and fetch are passed in, so the tests need no AWS. Every result line holds
 * outcomes, timings, token counts and HTTP statuses only: never a model's text, never the API key.
 * Prompts are fixed test sentences with no personal data.
 */

export type ConverseInput = {
  modelId: string;
  messages: { role: "user"; content: { text: string }[] }[];
  maxTokens: number;
  toolConfig?: Record<string, unknown>;
};
export type ConverseResult = {
  stopReason?: string;
  content: unknown[];
  usage?: { inputTokens?: number; outputTokens?: number };
  latencyMs?: number;
};
export type ConverseFn = (input: ConverseInput, signal: AbortSignal) => Promise<ConverseResult>;
export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>;

export type RigOptions = {
  region: string;
  modelIds: readonly string[];
  toolCheck: boolean;
  openaiCheck: boolean;
  /** Base URLs ending at the API root; "{region}" is replaced. */
  openaiBases: readonly string[];
  providerFieldCheck: boolean;
  /** The Bedrock API key's value (read from the variable --api-key-env names), or undefined. */
  apiKey: string | undefined;
  /** The variable's name, for messages. */
  apiKeyEnv: string;
  timeoutMs: number;
};

export type RigCheck = "converse" | "tool" | "openai";
export type RigLine = {
  ts: string;
  region: string;
  modelId: string;
  check: RigCheck;
  pass: boolean;
  latencyMs: number;
  base?: string;
  providerField?: boolean;
  status?: number;
  stopReason?: string;
  toolCall?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
};

export const DEFAULT_OPENAI_BASES = ["https://bedrock-runtime.{region}.amazonaws.com/openai/v1", "https://bedrock-mantle.{region}.api.aws/v1"] as const;
export const TOOL_NAME = "chainaim_private_ask";
const HELLO = "Say hello in one sentence.";
const TOOL_PROMPT = "Documents available: doc-1.txt. What follow-up does doc-1.txt mention? Use the tool.";

/** The tool spec the agent gives its model, in Converse's toolConfig shape. */
export const TOOL_CONFIG = {
  tools: [
    {
      toolSpec: {
        name: TOOL_NAME,
        description: "Ask ChainAim a question about one of the user's documents. Returns the answer with personal details masked.",
        inputSchema: {
          json: {
            type: "object",
            properties: { file: { type: "string", description: "The document's file name" }, question: { type: "string", description: "What to ask about the document" } },
            required: ["file", "question"],
          },
        },
      },
    },
  ],
};

/** An error as "Name: message", at most 300 characters, with the API key removed if it ever appears. */
export function errorText(e: unknown, apiKey: string | undefined): string {
  const err = e as { name?: unknown; message?: unknown };
  let text = `${typeof err?.name === "string" ? err.name : "Error"}: ${typeof err?.message === "string" ? err.message : String(e)}`;
  if (apiKey) text = text.split(apiKey).join("[key]");
  return text.replace(/\s+/g, " ").slice(0, 300);
}

const hasText = (content: unknown[]): boolean => content.some((b) => typeof (b as { text?: unknown })?.text === "string" && (b as { text: string }).text.trim() !== "");

function toolUseOf(content: unknown[]): { name?: unknown; input?: { file?: unknown } } | undefined {
  for (const b of content) {
    const use = (b as { toolUse?: { name?: unknown; input?: { file?: unknown } } })?.toolUse;
    if (use) return use;
  }
  return undefined;
}

export async function runRig(o: RigOptions, deps: { converse: ConverseFn; fetch: FetchFn; now?: () => Date }): Promise<RigLine[]> {
  const now = deps.now ?? (() => new Date());
  const lines: RigLine[] = [];
  const head = (modelId: string, check: RigCheck) => ({ ts: now().toISOString(), region: o.region, modelId, check });

  for (const modelId of o.modelIds) {
    // 1. converse
    {
      const started = performance.now();
      try {
        const r = await deps.converse({ modelId, messages: [{ role: "user", content: [{ text: HELLO }] }], maxTokens: 64 }, AbortSignal.timeout(o.timeoutMs));
        lines.push({ ...head(modelId, "converse"), pass: hasText(r.content), latencyMs: r.latencyMs ?? Math.round(performance.now() - started), stopReason: r.stopReason, inputTokens: r.usage?.inputTokens, outputTokens: r.usage?.outputTokens });
      } catch (e) {
        lines.push({ ...head(modelId, "converse"), pass: false, latencyMs: Math.round(performance.now() - started), error: errorText(e, o.apiKey) });
      }
    }
    // 2. tool
    if (o.toolCheck) {
      const started = performance.now();
      try {
        const r = await deps.converse({ modelId, messages: [{ role: "user", content: [{ text: TOOL_PROMPT }] }], maxTokens: 256, toolConfig: TOOL_CONFIG }, AbortSignal.timeout(o.timeoutMs));
        const use = toolUseOf(r.content);
        const toolCall = use?.name === TOOL_NAME && typeof use.input?.file === "string";
        lines.push({ ...head(modelId, "tool"), pass: r.stopReason === "tool_use" && toolCall, toolCall, latencyMs: r.latencyMs ?? Math.round(performance.now() - started), stopReason: r.stopReason, inputTokens: r.usage?.inputTokens, outputTokens: r.usage?.outputTokens });
      } catch (e) {
        lines.push({ ...head(modelId, "tool"), pass: false, latencyMs: Math.round(performance.now() - started), error: errorText(e, o.apiKey) });
      }
    }
    // 3. openai
    if (o.openaiCheck) {
      for (const template of o.openaiBases) {
        const url = template.replaceAll("{region}", o.region).replace(/\/+$/, "");
        for (const providerField of o.providerFieldCheck ? [false, true] : [false]) {
          if (!o.apiKey) {
            lines.push({ ...head(modelId, "openai"), base: url, providerField, pass: false, latencyMs: 0, error: `no Bedrock API key: set ${o.apiKeyEnv}` });
            continue;
          }
          const started = performance.now();
          const body: Record<string, unknown> = { model: modelId, messages: [{ role: "user", content: HELLO }], max_tokens: 64, stream: false };
          if (providerField) body.provider = { data_collection: "deny" };
          try {
            const res = await deps.fetch(`${url}/chat/completions`, {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${o.apiKey}` },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(o.timeoutMs),
            });
            const text = await res.text();
            let answered = false;
            let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
            try {
              const j = JSON.parse(text) as { choices?: { message?: { content?: unknown } }[]; usage?: typeof usage };
              const c = j.choices?.[0]?.message?.content;
              answered = typeof c === "string" && c.trim() !== "";
              usage = j.usage;
            } catch {
              /* not JSON */
            }
            const line: RigLine = { ...head(modelId, "openai"), base: url, providerField, pass: res.ok && answered, status: res.status, latencyMs: Math.round(performance.now() - started), inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens };
            // A refusal's text (the service's, never ours) helps decide the catalog option; any key is removed.
            if (!res.ok) line.error = errorText({ name: `HTTP ${res.status}`, message: text }, o.apiKey);
            lines.push(line);
          } catch (e) {
            lines.push({ ...head(modelId, "openai"), base: url, providerField, pass: false, latencyMs: Math.round(performance.now() - started), error: errorText(e, o.apiKey) });
          }
        }
      }
    }
  }
  return lines;
}
