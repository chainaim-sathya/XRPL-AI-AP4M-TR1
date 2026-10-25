/**
 * One chat call straight to OpenRouter (not through the gateway), to see what a hosted model sends back when the
 * gateway files it as upstream_error. The gateway never logs reply bodies; this script prints the shape of the reply
 * and, only when it is NOT a usable answer, the first characters of the body. The text sent is synthetic.
 * Needs OPENROUTER_API_KEY in the environment (never printed). Cost: one free-model call per run.
 *
 *   node scripts/probe-openrouter-chat.ts [--model ID] [--case answer|plain] [--max-tokens N] [--temperature T]
 *                                         [--base-url URL] [--excerpt N]
 *
 *   --model        OpenRouter model id (default nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free)
 *   --case         answer: shaped like the cross-file answer step (system rules, placeholder instruction, a 5-row
 *                  table whose names are <PERSON_n> placeholders); plain: one short question (default answer)
 *   --max-tokens   as the gateway sends it (default 2048, the CPU mode's output budget)
 *   --temperature  default 0, as crossask sends it
 *   --base-url     default https://openrouter.ai/api/v1
 *   --excerpt      characters of a non-answer body to print (default 600)
 */
import { parseArgs } from "node:util";
import { parseCompletion } from "../services/gateway/src/dispatch.ts";
import { categorize } from "../services/gateway/src/openrouter.ts";
import { PLACEHOLDER_INSTRUCTION } from "../services/gateway/src/privacy/restore.ts";
import { ANSWER_SYSTEM } from "../services/analyst/src/crossask.ts";

const { values: f } = parseArgs({ strict: true, options: {
  model: { type: "string", default: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free" },
  case: { type: "string", default: "answer" }, "max-tokens": { type: "string", default: "2048" },
  temperature: { type: "string", default: "0" }, "base-url": { type: "string", default: "https://openrouter.ai/api/v1" },
  excerpt: { type: "string", default: "600" },
} });
const fail = (m: string): never => { console.error(`probe: ${m}`); process.exit(2); };
const key = process.env.OPENROUTER_API_KEY ?? fail("OPENROUTER_API_KEY is not set in this window");
if (!/^sk-or-/.test(key) || /[\x00-\x20\x7f]/.test(key)) fail("OPENROUTER_API_KEY does not look like an OpenRouter key (sk-or-..., no spaces or control characters)");
if (f.case !== "answer" && f.case !== "plain") fail("--case must be answer or plain");
const maxTokens = Number(f["max-tokens"]), temperature = Number(f.temperature), excerpt = Number(f.excerpt);
if (!Number.isInteger(maxTokens) || maxTokens < 1) fail("--max-tokens must be a positive whole number");
if (!Number.isFinite(temperature)) fail("--temperature must be a number");

const table = ["Payer | Billed Claims Paid | Total Paid", "<PERSON_1> | 1351 | 359892.07", "<PERSON_2> | 1428 | 354263.58", "<PERSON_3> | 1184 | 280947.69", "<PERSON_4> | 1554 | 526758.08", "<PERSON_5> | 1402 | 342743.85"].join("\n");
const messages = f.case === "plain"
  ? [{ role: "user", content: "What is the capital of France? One word." }]
  : [{ role: "system", content: PLACEHOLDER_INSTRUCTION }, { role: "system", content: ANSWER_SYSTEM },
     { role: "user", content: `Question: For each payer, how many billed claims were paid, and how much was paid in total?\n\nQuery:\nSELECT p."Payer", count(DISTINCT p."Claim #"), round(sum(c."Paid Amount"), 2) FROM production p JOIN collections c ON p."Claim #" = c."Claim #" GROUP BY 1\n\nResult:\n${table}` }];

const started = Date.now();
const r = await fetch(`${f["base-url"]!.replace(/\/+$/, "")}/chat/completions`, {
  method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({ model: f.model, messages, max_tokens: maxTokens, temperature, stream: false, provider: { data_collection: "allow" } }),
});
const text = await r.text();
const ms = Date.now() - started;
let j: any; try { j = JSON.parse(text); } catch { j = undefined; }
const choice = j?.choices?.[0];
console.log(`case ${f.case}; model ${f.model}; max_tokens ${maxTokens}; temperature ${temperature}`);
console.log(`HTTP ${r.status} in ${ms} ms; gateway outcome: ${categorize(r.status, text, "allow").outcome}; usable answer: ${parseCompletion(text) ? "yes" : "NO"}`);
console.log(`json: ${j ? "yes" : "no"}; top-level keys: ${j ? Object.keys(j).join(", ") : "-"}`);
if (choice) console.log(`finish_reason: ${choice.finish_reason ?? "-"}; native: ${choice.native_finish_reason ?? "-"}; content chars: ${typeof choice.message?.content === "string" ? choice.message.content.length : "none"}; reasoning chars: ${typeof choice.message?.reasoning === "string" ? choice.message.reasoning.length : "none"}`);
if (j?.usage) console.log(`usage: ${JSON.stringify(j.usage)}`);
if (j?.error) console.log(`error: ${JSON.stringify(j.error).slice(0, excerpt)}`);
if (!parseCompletion(text)) console.log(`body (first ${excerpt} chars, synthetic request):\n${text.slice(0, excerpt)}`);
else console.log(`answer: ${String(choice.message.content).slice(0, 300)}`);
