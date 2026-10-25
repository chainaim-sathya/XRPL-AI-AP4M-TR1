/**
 * Generates the gateway's local-model files from config/local-models.json, the
 * one file you edit. Run by test-console/switch-models.ps1 -To ollama; you can
 * also run it by hand to see what it would do.
 *
 *   node scripts/local-models.ts [flags]
 *
 *   --in PATH                 model registry                        (default config/local-models.json)
 *   --out-dir DIR             where generated files go               (default config/generated)
 *   --ollama-api URL          Ollama on this PC, for checks/variants (default http://127.0.0.1:11434)
 *   --create-variants on|off  per-model context via `ollama create`  (default on)
 *   --check-context on|off    cap numCtx at the trained maximum      (default on)
 *   --ollama-bin NAME         the ollama command                     (default ollama)
 *
 * Writes <out-dir>/catalog.local.json, scores.local.json, summary.json and, with
 * variants on, ollama/<variant>.Modelfile. With variants on, each model is served
 * as "chainaim-<model>-ctx<numCtx>", an Ollama model that is the original plus
 * PARAMETER num_ctx, so each model loads with its own context. With variants off,
 * the original names are used and Ollama's context comes from OLLAMA_CONTEXT_LENGTH.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const TASKS = ["chat", "extraction", "rewrite", "code", "reasoning", "tool_use", "long_document"];
const SPEEDS = ["fast", "medium", "slow"];

type Entry = { id: string; servedModel: string; numCtx: number; maxOutputTokens: number; supportsTools: boolean; quality: number; tasks: string[]; speed: string;
  /** Hosted entry (e.g. a free OpenRouter model): served at this OpenAI-compatible URL instead of Ollama; no Ollama checks or variants. */
  baseUrl?: string;
  /** Hosted entry: the environment variable NAME that holds its key (never the key). */
  apiKeyEnv?: string;
  /** Catalog zone: local (default for Ollama entries), private-cloud, or public-api (default for hosted entries). */
  zone?: string;
  /** USD per million tokens (input, output). Default 0 (local, or a free hosted model); set it for a paid hosted model so the
   * gateway knows the real cost (e.g. Bedrock on-demand rates). */
  pricing?: { inputPerM: number; outputPerM: number } };
const ZONE_NAMES = ["local", "private-cloud", "public-api"];
const isHosted = (e: Entry): boolean => typeof e.baseUrl === "string";

function fail(message: string): never {
  console.error(`[local-models] ${message}`);
  process.exit(1);
}
const warn = (message: string) => console.warn(`[local-models] warning: ${message}`);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const onOff = (name: string, v: string) => (v === "on" ? true : v === "off" ? false : fail(`--${name} must be on or off, got ${v}`));

const { values: f } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  options: {
    in: { type: "string", default: "config/local-models.json" },
    "out-dir": { type: "string", default: "config/generated" },
    "ollama-api": { type: "string", default: "http://127.0.0.1:11434" },
    "create-variants": { type: "string", default: "on" },
    "check-context": { type: "string", default: "on" },
    "ollama-bin": { type: "string", default: "ollama" },
  },
});
const createVariants = onOff("create-variants", f["create-variants"]!);
const checkContext = onOff("check-context", f["check-context"]!);
const api = f["ollama-api"]!.replace(/\/+$/, "");
if (!URL.canParse(api)) fail(`--ollama-api must be a URL, got ${api}`);

let raw: unknown;
try {
  raw = JSON.parse(readFileSync(f.in!, "utf8").replace(/^﻿/, ""));
} catch (e) {
  fail(`cannot read ${f.in}: ${(e as Error).message}`);
}
if (!isObj(raw)) fail(`${f.in}: must be a JSON object`);
const ollamaUrl = raw.ollamaUrl;
if (typeof ollamaUrl !== "string" || !URL.canParse(ollamaUrl)) fail(`${f.in}: ollamaUrl must be a URL (the address the gateway container uses)`);
const defaults = isObj(raw.defaults) ? raw.defaults : {};
if (!Array.isArray(raw.models) || raw.models.length === 0) fail(`${f.in}: models must be a non-empty array`);

const entries: Entry[] = raw.models.map((m: unknown, i: number) => {
  const at = `${f.in}: models[${i}]`;
  if (!isObj(m)) fail(`${at} must be an object`);
  const e = { ...defaults, ...m } as Record<string, unknown>;
  if (typeof e.id !== "string" || !/^[\w.-]+\/[\w.:-]+$/.test(e.id) || e.id.startsWith("chainaim/")) fail(`${at}.id must look like "local/<name>"`);
  if (typeof e.servedModel !== "string" || !e.servedModel) fail(`${at}.servedModel is required (the name \`ollama list\` shows)`);
  for (const k of ["numCtx", "maxOutputTokens"]) if (!Number.isInteger(e[k]) || (e[k] as number) < 256) fail(`${at}.${k} must be an integer >= 256`);
  if (typeof e.supportsTools !== "boolean") fail(`${at}.supportsTools must be true or false`);
  if (typeof e.quality !== "number") fail(`${at}.quality must be a number`);
  if (!Array.isArray(e.tasks) || !e.tasks.every((t) => TASKS.includes(t as string))) fail(`${at}.tasks must be from ${TASKS.join(", ")}`);
  if (!SPEEDS.includes(e.speed as string)) fail(`${at}.speed must be fast, medium or slow`);
  if (e.baseUrl !== undefined) {
    if (typeof e.baseUrl !== "string" || !/^https?:\/\//.test(e.baseUrl) || !URL.canParse(e.baseUrl)) fail(`${at}.baseUrl must be an http(s) URL (an OpenAI-compatible API, e.g. https://openrouter.ai/api/v1)`);
    if (e.apiKeyEnv !== undefined && (typeof e.apiKeyEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(e.apiKeyEnv))) fail(`${at}.apiKeyEnv must be an environment variable NAME, not a key`);
  } else if (e.apiKeyEnv !== undefined) fail(`${at}.apiKeyEnv needs baseUrl (only hosted entries carry a key)`);
  if (e.zone !== undefined && !ZONE_NAMES.includes(e.zone as string)) fail(`${at}.zone must be one of ${ZONE_NAMES.join(", ")}`);
  if (e.pricing !== undefined) {
    const p = e.pricing as { inputPerM?: unknown; outputPerM?: unknown };
    if (typeof p !== "object" || p === null || typeof p.inputPerM !== "number" || typeof p.outputPerM !== "number" || p.inputPerM < 0 || p.outputPerM < 0) fail(`${at}.pricing must be {"inputPerM": number >= 0, "outputPerM": number >= 0} (USD per million tokens)`);
  }
  return e as unknown as Entry;
});
const ids = entries.map((e) => e.id);
if (new Set(ids).size !== ids.length) fail(`${f.in}: model ids must be unique`);
const defaultModel = typeof raw.defaultModel === "string" ? raw.defaultModel : ids[0];
if (!ids.includes(defaultModel)) fail(`${f.in}: defaultModel ${defaultModel} is not one of the models`);

/** The trained maximum context Ollama reports for a model, or undefined when it does not say. Exits when the model is not pulled. */
async function trainedContext(model: string): Promise<number | undefined> {
  let res: Response;
  try {
    res = await fetch(`${api}/api/show`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, name: model }), signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    fail(`cannot reach Ollama at ${api} (${(e as Error).message}). Start Ollama, or pass --check-context off --create-variants off.`);
  }
  if (res.status === 404) fail(`Ollama does not have ${model}. Run: ollama pull ${model}`);
  if (!res.ok) fail(`Ollama answered HTTP ${res.status} for ${model}`);
  const body = (await res.json().catch(() => null)) as { model_info?: Record<string, unknown> } | null;
  const key = Object.keys(body?.model_info ?? {}).find((k) => k.endsWith(".context_length"));
  const n = key ? body!.model_info![key] : undefined;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
}

const outDir = resolve(f["out-dir"]!);
mkdirSync(join(outDir, "ollama"), { recursive: true });

const models: Record<string, unknown>[] = [];
const scoreModels: Record<string, unknown> = {};
for (const e of entries) {
  let ctx = e.numCtx;
  if (isHosted(e)) {
    // Hosted: no Ollama involved; the model name and context are taken as written in the registry.
    if (e.maxOutputTokens >= ctx) fail(`${e.id}: maxOutputTokens ${e.maxOutputTokens} must be below its context ${ctx}, or no prompt fits`);
    const deployment: Record<string, unknown> = { id: `${e.id.split("/")[1]}@hosted`, adapter: "openai", baseUrl: e.baseUrl, servedModel: e.servedModel, probe: false };
    if (e.apiKeyEnv) deployment.apiKeyEnv = e.apiKeyEnv;
    models.push({
      id: e.id,
      zone: e.zone ?? "public-api",
      capabilities: { contextWindow: ctx, maxOutputTokens: e.maxOutputTokens, supportsTools: e.supportsTools, supportsVision: false },
      pricing: e.pricing ?? { inputPerM: 0, outputPerM: 0 },
      deployments: [deployment],
    });
    scoreModels[e.id] = { quality: e.quality, tasks: e.tasks, speed: e.speed, domains: [] };
    console.log(`[local-models] ${e.id} -> hosted ${e.servedModel} at ${e.baseUrl} (zone ${e.zone ?? "public-api"}${e.apiKeyEnv ? `, key from ${e.apiKeyEnv}` : ""})`);
    continue;
  }
  if (checkContext || createVariants) {
    const trained = await trainedContext(e.servedModel);
    if (trained === undefined) warn(`${e.servedModel}: Ollama did not report a trained context length; using numCtx ${ctx} unchecked`);
    else if (ctx > trained) {
      warn(`${e.servedModel}: numCtx ${ctx} is above its trained maximum ${trained}; using ${trained}`);
      ctx = trained;
    }
  }
  if (e.maxOutputTokens >= ctx) fail(`${e.id}: maxOutputTokens ${e.maxOutputTokens} must be below its context ${ctx}, or no prompt fits`);
  let served = e.servedModel;
  if (createVariants) {
    served = `chainaim-${e.servedModel.replace(/[:/]/g, "-")}-ctx${ctx}`.toLowerCase();
    const file = join(outDir, "ollama", `${served}.Modelfile`);
    writeFileSync(file, `# Generated from ${f.in} by scripts/local-models.ts. Do not edit.\nFROM ${e.servedModel}\nPARAMETER num_ctx ${ctx}\n`);
    try {
      execFileSync(f["ollama-bin"]!, ["create", served, "-f", file], { stdio: ["ignore", "ignore", "inherit"] });
    } catch (err) {
      fail(`ollama create ${served} failed (${(err as Error).message})`);
    }
    console.log(`[local-models] ${e.id} -> ${served} (num_ctx ${ctx})`);
  }
  models.push({
    id: e.id,
    zone: e.zone ?? "local",
    capabilities: { contextWindow: ctx, maxOutputTokens: e.maxOutputTokens, supportsTools: e.supportsTools, supportsVision: false },
    pricing: e.pricing ?? { inputPerM: 0, outputPerM: 0 },
    deployments: [{ id: `${e.id.split("/")[1]}@ollama-host`, adapter: "openai", baseUrl: ollamaUrl, servedModel: served }],
  });
  scoreModels[e.id] = { quality: e.quality, tasks: e.tasks, speed: e.speed, domains: [] };
}

// The default model ranks first for any request that names no model. Easy requests (difficulty 1-2) add a speed
// bonus (routing/scores.ts), so the default must also count as fast: with the highest quality, every task and the
// top speed class, its score is strictly above every other model's at every difficulty.
const top = Math.max(...entries.map((e) => e.quality));
scoreModels[defaultModel] = { ...(scoreModels[defaultModel] as object), quality: top + 1, tasks: TASKS, speed: "fast" };

const order = [defaultModel, ...ids.filter((id) => id !== defaultModel)];
const chains = { SIMPLE: order, MEDIUM: order, COMPLEX: order, REASONING: order };
const toolIds = order.filter((id) => entries.find((e) => e.id === id)!.supportsTools);
const catalog: Record<string, unknown> = {
  version: `generated-${new Date().toISOString()}`,
  notes: `GENERATED from ${f.in} by scripts/local-models.ts. Do not edit; edit ${f.in} and run test-console/use-ollama.cmd. Profiles are required by the catalog format; chat routing uses scores.local.json.`,
  models,
  profiles: { auto: chains, eco: chains, premium: chains },
};
if (toolIds.length) catalog.agentic = { SIMPLE: toolIds, MEDIUM: toolIds, COMPLEX: toolIds, REASONING: toolIds };

const scores = {
  version: catalog.version,
  notes: `GENERATED from ${f.in}. The default model (${defaultModel}) ranks first.`,
  weights: { qualityByDifficulty: [0.5, 0.75, 1.0, 1.25, 1.5], taskMatch: 2, domainMatch: 2, speedWhenEasy: { fast: 2, medium: 1, slow: 0 } },
  defaults: { qualityBySize: [[300, 8], [100, 7], [25, 6], [8, 5], [0, 3]], unknownSizeQuality: 1, speedBySize: [[100, "slow"], [25, "medium"], [0, "fast"]], unknownSizeSpeed: "slow" },
  models: scoreModels,
};

const outputs = entries.map((e) => e.maxOutputTokens);
const maxOutputTokens = Math.min(...outputs);
if (new Set(outputs).size > 1) warn(`maxOutputTokens differ (${[...new Set(outputs)].join(", ")}); requests get ${maxOutputTokens}, the smallest, so no model is excluded`);

const rel = (p: string) => relative(process.cwd(), p).replace(/\\/g, "/");
const catalogPath = join(outDir, "catalog.local.json");
const scoresPath = join(outDir, "scores.local.json");
writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
writeFileSync(scoresPath, JSON.stringify(scores, null, 2) + "\n");
const summary = { catalog: rel(catalogPath), scores: rel(scoresPath), maxOutputTokens, defaultModel, variants: createVariants, models: models.map((m) => ({ id: m.id, servedModel: (m.deployments as { servedModel: string }[])[0].servedModel, contextWindow: (m.capabilities as { contextWindow: number }).contextWindow })) };
writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(`[local-models] wrote ${summary.catalog} and ${summary.scores}; max output ${maxOutputTokens}; default ${defaultModel}`);
