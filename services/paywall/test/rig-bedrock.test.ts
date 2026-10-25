/** Rig R5 (scripts/rigs/bedrock-core.ts) with stand-ins for Converse and fetch: no AWS is called. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runRig, TOOL_NAME, type ConverseFn, type FetchFn, type RigOptions } from "../scripts/rigs/bedrock-core.ts";

const KEY = "ABSKtest-bedrock-key-value-1234567890";
const options = (extra: Partial<RigOptions> = {}): RigOptions => ({
  region: "ap-southeast-2",
  modelIds: ["nvidia.nemotron-nano-3-30b"],
  toolCheck: true,
  openaiCheck: false,
  openaiBases: ["https://bedrock-runtime.{region}.amazonaws.com/openai/v1"],
  providerFieldCheck: true,
  apiKey: undefined,
  apiKeyEnv: "BEDROCK_API_KEY",
  timeoutMs: 5000,
  ...extra,
});

/** Converse that answers text, and a tool call when given tools (as Nemotron did on 2026-10-24). */
const goodConverse: ConverseFn = async (input) =>
  input.toolConfig
    ? { stopReason: "tool_use", content: [{ text: "\n" }, { toolUse: { toolUseId: "t1", name: TOOL_NAME, input: { file: "doc-1.txt", question: "q" } } }], usage: { inputTokens: 359, outputTokens: 51 }, latencyMs: 423 }
    : { stopReason: "end_turn", content: [{ text: "Hello!" }], usage: { inputTokens: 21, outputTokens: 10 }, latencyMs: 254 };

const noFetch: FetchFn = async () => {
  throw new Error("fetch must not be called");
};

describe("rig R5 (Bedrock)", () => {
  it("R5 passes converse and tool checks for a model that answers and calls the tool", async () => {
    const lines = await runRig(options(), { converse: goodConverse, fetch: noFetch });
    assert.deepEqual(
      lines.map((l) => [l.check, l.pass]),
      [
        ["converse", true],
        ["tool", true],
      ],
    );
    assert.equal(lines[1].toolCall, true);
    assert.equal(lines[1].inputTokens, 359);
    assert.equal(lines[0].region, "ap-southeast-2");
  });

  it("R5 fails the tool check when the model answers in text instead of calling the tool", async () => {
    const textOnly: ConverseFn = async () => ({ stopReason: "end_turn", content: [{ text: "I would look at doc-1.txt." }] });
    const lines = await runRig(options(), { converse: textOnly, fetch: noFetch });
    const tool = lines.find((l) => l.check === "tool")!;
    assert.equal(tool.pass, false);
    assert.equal(tool.toolCall, false);
  });

  it("R5 records an AWS error by name and keeps going to the next model", async () => {
    const denied: ConverseFn = async (input) => {
      if (input.modelId === "denied.model") throw Object.assign(new Error("You don't have access to the model with the specified model ID."), { name: "AccessDeniedException" });
      return goodConverse(input, AbortSignal.timeout(1000));
    };
    const lines = await runRig(options({ modelIds: ["denied.model", "nvidia.nemotron-nano-3-30b"] }), { converse: denied, fetch: noFetch });
    assert.equal(lines.length, 4);
    assert.match(lines[0].error ?? "", /^AccessDeniedException: /);
    assert.equal(lines[0].pass, false);
    assert.ok(lines.slice(2).every((l) => l.pass));
  });

  it("R5 openai: without a key, says which variable to set and calls nothing", async () => {
    const lines = await runRig(options({ openaiCheck: true }), { converse: goodConverse, fetch: noFetch });
    const openai = lines.filter((l) => l.check === "openai");
    assert.equal(openai.length, 2, "with and without the provider field");
    assert.ok(openai.every((l) => !l.pass && /set BEDROCK_API_KEY/.test(l.error ?? "")));
  });

  it("R5 openai: tells apart a refused provider field, sends the key only as Bearer, and never records it", async () => {
    const seen: { url: string; auth: string; body: Record<string, unknown> }[] = [];
    const fetchStub: FetchFn = async (url, init) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      seen.push({ url, auth: init.headers.authorization, body });
      if (body.provider) return new Response(JSON.stringify({ error: { message: `Unknown field: provider (key ${KEY})` } }), { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "Hello!" } }], usage: { prompt_tokens: 12, completion_tokens: 5 } }), { status: 200 });
    };
    const lines = await runRig(options({ openaiCheck: true, apiKey: KEY }), { converse: goodConverse, fetch: fetchStub });
    const [plain, withProvider] = lines.filter((l) => l.check === "openai");
    assert.equal(seen[0].url, "https://bedrock-runtime.ap-southeast-2.amazonaws.com/openai/v1/chat/completions");
    assert.equal(seen[0].auth, `Bearer ${KEY}`);
    assert.equal(seen[0].body.model, "nvidia.nemotron-nano-3-30b");
    assert.equal(plain.pass, true);
    assert.equal(plain.inputTokens, 12);
    assert.equal(withProvider.pass, false);
    assert.equal(withProvider.status, 400);
    assert.match(withProvider.error ?? "", /Unknown field: provider/);
    assert.ok(!JSON.stringify(lines).includes(KEY), "the API key is never in a result line");
    assert.ok(!JSON.stringify(lines).includes("Hello!"), "a model's text is never in a result line");
  });
});
