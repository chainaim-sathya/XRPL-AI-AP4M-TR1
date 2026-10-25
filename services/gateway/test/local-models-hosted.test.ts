/** scripts/local-models.ts with a hosted entry (H2): no Ollama steps, zone public-api, key by NAME; local entries unchanged. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { validateCatalog } from "../src/catalog.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const run = (registry: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), "chainaim-lm-"));
  const reg = join(dir, "registry.json");
  writeFileSync(reg, JSON.stringify(registry));
  const out = join(dir, "out");
  // Ollama is not running in tests: checks and variants off (a hosted entry never needs them).
  execFileSync(process.execPath, ["scripts/local-models.ts", "--in", reg, "--out-dir", out, "--create-variants", "off", "--check-context", "off"], { cwd: ROOT, stdio: "pipe" });
  return JSON.parse(readFileSync(join(out, "catalog.local.json"), "utf8"));
};
const base = {
  ollamaUrl: "http://host.docker.internal:11434/v1",
  defaultModel: "local/qwen2.5-3b",
  defaults: { numCtx: 8192, maxOutputTokens: 2048, supportsTools: false, quality: 5, tasks: ["chat"], speed: "medium" },
};

describe("local-models.ts hosted entries", () => {
  it("emits a hosted entry with its URL, served name, key NAME and zone public-api, next to an unchanged local entry", () => {
    const catalog = run({ ...base, models: [
      { id: "local/qwen2.5-3b", servedModel: "qwen2.5:3b" },
      { id: "hosted/nemotron-nano-reasoning", servedModel: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", numCtx: 32768, tasks: ["chat", "reasoning"] },
    ] });
    const v = validateCatalog(catalog);
    const local = v.models.find((m) => m.id === "local/qwen2.5-3b")!;
    const hosted = v.models.find((m) => m.id === "hosted/nemotron-nano-reasoning")!;
    assert.equal(local.zone, "local");
    assert.equal(local.deployments[0].baseUrl, "http://host.docker.internal:11434/v1");
    assert.equal(local.deployments[0].apiKeyEnv, undefined);
    assert.equal(hosted.zone, "public-api");
    assert.equal(hosted.deployments[0].baseUrl, "https://openrouter.ai/api/v1");
    assert.equal(hosted.deployments[0].servedModel, "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free");
    assert.equal(hosted.deployments[0].apiKeyEnv, "OPENROUTER_API_KEY");
    assert.equal(hosted.capabilities.contextWindow, 32768);
    assert.ok(!JSON.stringify(catalog).includes("sk-or-"), "no key value is ever written");
  });

  it("carries a hosted model's price (USD per 1M tokens) and refuses a bad one; local and free stay 0", () => {
    const catalog = run({ ...base, models: [
      { id: "local/qwen2.5-3b", servedModel: "qwen2.5:3b" },
      { id: "bedrock/x", servedModel: "nvidia.x", baseUrl: "https://bedrock-runtime.ap-southeast-2.amazonaws.com/openai/v1", apiKeyEnv: "BEDROCK_API_KEY", zone: "private-cloud", pricing: { inputPerM: 0.0618, outputPerM: 0.2472 } },
    ] });
    const v = validateCatalog(catalog);
    assert.deepEqual(v.models.find((m) => m.id === "bedrock/x")!.pricing, { inputPerM: 0.0618, outputPerM: 0.2472 });
    assert.equal(v.models.find((m) => m.id === "bedrock/x")!.zone, "private-cloud");
    assert.deepEqual(v.models.find((m) => m.id === "local/qwen2.5-3b")!.pricing, { inputPerM: 0, outputPerM: 0 });
    assert.throws(() => run({ ...base, models: [{ id: "local/qwen2.5-3b", servedModel: "qwen2.5:3b" }, { id: "bedrock/x", servedModel: "x", baseUrl: "https://example.com/v1", pricing: { inputPerM: -1, outputPerM: 0 } }] }));
  });

  it("the shipped all-in-one registry and mode: local + OpenRouter + Bedrock in one gateway, auto and health data local", () => {
    const reg = JSON.parse(readFileSync(join(ROOT, "config", "local-models.cpu-all.json"), "utf8"));
    const v = validateCatalog(run(reg));
    const zones = Object.fromEntries(v.models.map((m) => [m.id, m.zone]));
    assert.deepEqual([zones["local/qwen2.5-3b"], zones["hosted/nemotron-nano-reasoning"], zones["bedrock/nemotron-nano-3-30b"]], ["local", "public-api", "private-cloud"]);
    assert.deepEqual(v.models.find((m) => m.id === "bedrock/nemotron-nano-3-30b")!.deployments[0].apiKeyEnv, "BEDROCK_API_KEY");
    const mode = JSON.parse(readFileSync(join(ROOT, "test-console", "modes", "ollama-cpu-8gb-all.json"), "utf8"));
    assert.equal(mode.localModels, "config/local-models.cpu-all.json");
    assert.deepEqual(mode.secretEnv, ["OPENROUTER_API_KEY", "BEDROCK_API_KEY"]);
    const at = (flag: string) => mode.flags[mode.flags.indexOf(flag) + 1];
    assert.equal(at("--auto-zones"), "local");
    assert.equal(at("--phi-zones"), "local");
    assert.ok(!/sk-or-|ABSK|AKIA/.test(JSON.stringify(reg) + JSON.stringify(mode)), "no key values in either file");
  });

  it("refuses a key value where a variable name belongs, and a key on a local entry", () => {
    assert.throws(() => run({ ...base, models: [{ id: "local/qwen2.5-3b", servedModel: "qwen2.5:3b" }, { id: "hosted/x", servedModel: "x", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "sk-or-v1-abc" }] }));
    assert.throws(() => run({ ...base, models: [{ id: "local/qwen2.5-3b", servedModel: "qwen2.5:3b", apiKeyEnv: "OPENROUTER_API_KEY" }] }));
  });
});
