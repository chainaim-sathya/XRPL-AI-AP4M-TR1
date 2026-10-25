/**
 * Rig R5 (Bedrock): PASS/FAIL per model, appended as JSON lines. Logic in bedrock-core.ts.
 *
 *   node scripts/rigs/bedrock.ts
 *   node scripts/rigs/bedrock.ts --openai-check on          (needs the Bedrock API key in BEDROCK_API_KEY)
 *   node scripts/rigs/bedrock.ts --model-id nvidia.nemotron-nano-3-30b --model-id nvidia.nemotron-super-3-120b
 *
 * --region                AWS region (default ap-southeast-2, the free-plan project's region)
 * --model-id              Bedrock model id; repeat for several (default nvidia.nemotron-nano-3-30b)
 * --tool-check            on|off: Converse with a tool shaped like chainaim_private_ask (default on)
 * --openai-check          on|off: OpenAI-compatible Chat Completions with a Bedrock API key (default off)
 * --openai-base           base URL ending at the API root, "{region}" replaced; repeat for several
 *                         (default: https://bedrock-runtime.{region}.amazonaws.com/openai/v1 and
 *                         https://bedrock-mantle.{region}.api.aws/v1)
 * --provider-field-check  on|off: also send the gateway's OpenRouter field { provider: { data_collection } } (default on)
 * --api-key-env           variable holding the Bedrock API key (default BEDROCK_API_KEY); the key is never printed or written
 * --timeout-ms            per call (default 30000)
 * --out                   JSON-lines file to append to (default rig/out/rigs.jsonl at the repository root)
 *
 * Converse uses the AWS SDK's usual credentials (AWS_PROFILE=chainaim after `aws login`).
 * Exit code: 0 when every check passed, 1 when any failed, 2 for a usage problem.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { DEFAULT_OPENAI_BASES, runRig, type ConverseFn, type FetchFn } from "./bedrock-core.ts";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

const { values } = parseArgs({
  options: {
    region: { type: "string", default: "ap-southeast-2" },
    "model-id": { type: "string", multiple: true },
    "tool-check": { type: "string", default: "on" },
    "openai-check": { type: "string", default: "off" },
    "openai-base": { type: "string", multiple: true },
    "provider-field-check": { type: "string", default: "on" },
    "api-key-env": { type: "string", default: "BEDROCK_API_KEY" },
    "timeout-ms": { type: "string", default: "30000" },
    out: { type: "string", default: join(REPO, "rig", "out", "rigs.jsonl") },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}
function onOff(name: string, raw: string): boolean {
  if (raw !== "on" && raw !== "off") fail(`--${name} must be on or off`);
  return raw === "on";
}
const timeoutMs = Number(values["timeout-ms"]);
if (!/^\d+$/.test(values["timeout-ms"]) || timeoutMs < 1000 || timeoutMs > 600000) fail("--timeout-ms must be a whole number from 1000 to 600000");
if (!/^[A-Z_][A-Z0-9_]*$/.test(values["api-key-env"])) fail("--api-key-env must be a variable NAME, not the key");
const toolCheck = onOff("tool-check", values["tool-check"]);
const openaiCheck = onOff("openai-check", values["openai-check"]);
const providerFieldCheck = onOff("provider-field-check", values["provider-field-check"]);
const apiKey = process.env[values["api-key-env"]]?.trim() || undefined;

const client = new BedrockRuntimeClient({ region: values.region });
const converse: ConverseFn = async (input, signal) => {
  const started = performance.now();
  const r = await client.send(
    new ConverseCommand({
      modelId: input.modelId,
      messages: input.messages,
      inferenceConfig: { maxTokens: input.maxTokens },
      ...(input.toolConfig ? { toolConfig: input.toolConfig as never } : {}),
    }),
    { abortSignal: signal },
  );
  return {
    stopReason: r.stopReason,
    content: (r.output as { message?: { content?: unknown[] } } | undefined)?.message?.content ?? [],
    usage: r.usage,
    latencyMs: r.metrics?.latencyMs ?? Math.round(performance.now() - started),
  };
};

const lines = await runRig(
  {
    region: values.region,
    modelIds: values["model-id"]?.length ? values["model-id"] : ["nvidia.nemotron-nano-3-30b"],
    toolCheck,
    openaiCheck,
    openaiBases: values["openai-base"]?.length ? values["openai-base"] : [...DEFAULT_OPENAI_BASES],
    providerFieldCheck,
    apiKey,
    apiKeyEnv: values["api-key-env"],
    timeoutMs,
  },
  { converse, fetch: fetch as unknown as FetchFn },
);

mkdirSync(dirname(values.out), { recursive: true });
appendFileSync(values.out, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
for (const l of lines) {
  const where = l.check === "openai" ? ` ${l.base}${l.providerField ? " +provider" : ""}` : "";
  const extra = [
    l.status !== undefined ? `HTTP ${l.status}` : "",
    l.stopReason ?? "",
    l.toolCall !== undefined ? `toolCall=${l.toolCall}` : "",
    l.inputTokens !== undefined ? `${l.inputTokens}/${l.outputTokens ?? "?"} tok` : "",
  ]
    .filter(Boolean)
    .join(", ");
  console.log(`${l.pass ? "PASS" : "FAIL"} ${l.modelId} ${l.check}${where} ${l.latencyMs} ms${extra ? ` (${extra})` : ""}${l.error ? ` - ${l.error}` : ""}`);
}
console.log(`${lines.filter((l) => l.pass).length} of ${lines.length} passed; appended to ${values.out}`);
// process.exitCode, not process.exit(), after network calls (Windows).
process.exitCode = lines.every((l) => l.pass) ? 0 : 1;
