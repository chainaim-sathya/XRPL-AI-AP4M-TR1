/**
 * Ask a question across the CSV/TSV files of one folder, from the terminal (the console's "Ask across files" box runs
 * the same steps, src/crossask.ts). The analyst must be running (test-console\start-analyst.cmd); with --phrase llm
 * or without --sql, the gateway too.
 *
 *   node scripts/ask.ts --folder C:\PRIV-AI-DATA\clinic --question "How many visits per plan?" [flags]
 *
 *   --folder PATH          the data folder (inside allowedRoots of config/data-sources.json)        (required)
 *   --question TEXT        the question                                                              (required)
 *   --relations            only print the tables and relations found, then stop (no model is called)
 *   --sql TEXT             run this SELECT yourself instead of asking a model to write one
 *   --phrase llm|none      llm: the model also words the answer from the result (the result rows go to it, through
 *                          the gateway's masking and zone rules); none: print the result table only   (default llm)
 *   --model ID             e.g. chainaim/auto, local/qwen2.5-3b, hosted/nemotron-nano-reasoning      (default chainaim/auto)
 *   --answer-model ID      model that words the answer (default: --model). E.g. --model hosted/... --answer-model
 *                          local/qwen2.5-3b: a hosted model writes the query from the headers, and the result rows
 *                          never leave this PC
 *   --sql-retries N        times the model may fix a query that failed                               (default 1)
 *   --answer-max-rows N    result rows sent for the answer                                           (default 50)
 *   --analyst URL          (default http://127.0.0.1:8740)
 *   --gateway URL          (default http://127.0.0.1:8720)
 *   --key-file PATH        the gateway key file (default ../../../test-console/local-gateway-key.txt from this script)
 *   --key-env NAME         or read the gateway key from this environment variable instead
 *   --timeout-sec N        per call to the analyst or the gateway                                     (default 300)
 *   --json                 print the whole result as JSON
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { analystClient, crossAsk, gatewayChat, resultText } from "../src/crossask.ts";

const { values: f } = parseArgs({
  args: process.argv.slice(2), strict: true,
  options: {
    folder: { type: "string" }, question: { type: "string" }, relations: { type: "boolean", default: false }, sql: { type: "string" },
    phrase: { type: "string", default: "llm" }, model: { type: "string", default: "chainaim/auto" }, "answer-model": { type: "string" },
    "sql-retries": { type: "string", default: "1" }, "answer-max-rows": { type: "string", default: "50" },
    analyst: { type: "string", default: "http://127.0.0.1:8740" }, gateway: { type: "string", default: "http://127.0.0.1:8720" },
    "key-file": { type: "string", default: fileURLToPath(new URL("../../../test-console/local-gateway-key.txt", import.meta.url)) },
    "key-env": { type: "string" }, "timeout-sec": { type: "string", default: "300" }, json: { type: "boolean", default: false },
  },
});
const fail = (m: string): never => { console.error(`ask: ${m}`); process.exit(2); };
const int = (name: string, v: string | undefined, min: number): number => { const n = Number(v); if (!Number.isInteger(n) || n < min) fail(`--${name} must be a whole number >= ${min}, got ${v}`); return n; };
if (!f.folder) fail("--folder is required");
if (!f.relations && !f.question) fail("--question is required");
if (f.phrase !== "llm" && f.phrase !== "none") fail(`--phrase must be llm or none, got ${f.phrase}`);
if (!/^[\w.-]+\/[\w.:-]+$/.test(f.model!)) fail(`--model must look like provider/name, got ${f.model}`);
if (f["answer-model"] !== undefined && !/^[\w.-]+\/[\w.:-]+$/.test(f["answer-model"])) fail(`--answer-model must look like provider/name, got ${f["answer-model"]}`);
if (f["key-env"] !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(f["key-env"])) fail("--key-env takes an environment variable NAME");
const timeoutMs = int("timeout-sec", f["timeout-sec"], 1) * 1000;
const analyst = analystClient(f.analyst!, timeoutMs);

async function main(): Promise<void> {
  if (f.relations) {
    const r = await analyst("relations", { folder: f.folder });
    if (f.json) console.log(JSON.stringify(r, null, 2)); else console.log(r.schema + (r.skipped?.length ? `\n\nSkipped (over --max-bytes): ${r.skipped.join(", ")}` : ""));
    process.exit(0);
  }
  const needsModel = !f.sql || f.phrase === "llm";
  let key = "";
  if (needsModel) {
    key = f["key-env"] ? (process.env[f["key-env"]] ?? "") : (() => { try { return readFileSync(f["key-file"]!, "utf8").trim(); } catch { return ""; } })();
    if (!key) fail(f["key-env"] ? `environment variable ${f["key-env"]} is empty` : `no gateway key in ${f["key-file"]}`);
  }
  const res = await crossAsk(
    { folder: f.folder!, question: f.question!, model: f.model!, answerModel: f["answer-model"], phrase: f.phrase as "llm" | "none", sqlRetries: int("sql-retries", f["sql-retries"], 0), answerMaxRows: int("answer-max-rows", f["answer-max-rows"], 1), sql: f.sql },
    { analyst, chat: needsModel ? gatewayChat({ url: f.gateway!, key, timeoutMs }) : async () => fail("no model should be called") },
  );
  if (f.json) { console.log(JSON.stringify(res, null, 2)); process.exit(res.error ? 1 : 0); }
  console.log(`QUESTION  ${res.question}`);
  console.log(`RELATIONS ${res.relations.length} found (run with --relations to see them)`);
  for (const [i, a] of res.attempts.entries()) console.log(`QUERY ${i + 1}   ${a.sql || "(none)"}${a.error ? `\n          -> ${a.error}` : ""}`);
  for (const s of res.sentToModel) console.log(`SENT      ${s.step}: ${s.chars} chars, ${s.hasData ? "includes result rows (masked by the gateway)" : "headers and relations only, no data"}`);
  for (const s of res.served) if (s.model) console.log(`SERVED    ${s.model}${s.zone ? ` (zone ${s.zone})` : ""}`);
  if (res.result) console.log(`\nRESULT\n${resultText(res.result, 50)}`);
  for (const w of res.warnings ?? []) console.log(`WARNING   ${w} - do not trust these totals`);
  if (res.error) { console.log(`\nERROR     ${res.error}`); process.exit(1); }
  if (res.answer !== null) {
    console.log(`\nANSWER\n${res.answer}`);
    console.log(res.unverified.length ? `\nCHECK     numbers or placeholders not in the result: ${res.unverified.join(", ")}` : "\nCHECK     every number in the answer is in the result");
  }
}
main().catch((e) => { console.error(`ask: ${(e as Error).message}`); process.exit(1); });
