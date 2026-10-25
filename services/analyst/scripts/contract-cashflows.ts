/**
 * Contract documents -> loan terms -> ACTUS cash flows, saved next to the books so CFO questions can use them.
 *
 *   node scripts/contract-cashflows.ts --folder C:\PRIV-AI-DATA\smb\jupiter-knits [--contracts <dir>] [--file <one.md>]
 *        --extract-model local/qwen2.5-3b  --via direct --actus-url http://<host>:8083
 *        [--via mentor --mentor-url http://<host>]   [--out loan_schedules.csv] [--postman-out <file.json>]
 *
 * For each .md / .txt document (default: <folder>\contracts):
 *   1. terms: a model reads the document through the gateway (it masks names, keeps the numbers) and returns JSON
 *      terms (TERMS_SYSTEM in src/actus.ts). Or --terms-json '<json>' for one --file, then no model is used.
 *   2. check: every value must be IN the document (amount, rate, dates, term, kind of repayment); a made-up value
 *      stops that document before anything is sent to ACTUS.
 *   3. contract: --via direct builds the ACTUS contract here (PAM / ANN, fixed rate); --via mentor asks ACTUS Mentor
 *      to build it from the checked terms (plain English, no party names) and checks Mentor's contract against the
 *      terms (type, amount, rate, dates) before running it.
 *   4. run + check: ACTUS status Success, IED = amount, principal repaid = amount, last event on maturity.
 *   5. save: <folder>\loan_schedules.csv (Contract ID = document name; the rows of that contract are replaced,
 *      others kept). The analyst reads it with the other files.
 *
 *   --folder DIR           the data folder (required)          --contracts DIR    (default <folder>\contracts)
 *   --file FILE            one document instead of the whole contracts folder
 *   --terms-json JSON      terms for --file, written by you (skips the model)
 *   --extract-model ID     (default local/qwen2.5-3b: the document stays on this PC)
 *   --extract-retries N    times the model may correct terms that failed the document check (default 1); the
 *                          failed checks are sent back to it, and its last answer must still pass the check
 *   --gateway URL          (default http://127.0.0.1:8720)  --key-file PATH | --key-env NAME (gateway key, as ask.ts)
 *   --via direct|mentor    (default direct)  --actus-url URL (or ACTUS_URL)  --mentor-url URL (or ACTUS_MENTOR_URL)
 *   --mentor-key-env NAME  (default ACTUS_MENTOR_API_KEY; the key is read from the environment, never from a file)
 *   --out NAME             (default loan_schedules.csv, inside --folder)   --postman-out FILE   --timeout-sec N (default 120)
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type ActusResult, type Payload, type Terms, SCHEDULE_HEADER, TERMS_SYSTEM, buildContract, checkTerms, intentChecks, maturityOf, mentorBuild, mentorRun, parseTerms, runDirect, scheduleChecks, scheduleRows, termsInDocument } from "../src/actus.ts";
import { gatewayChat } from "../src/crossask.ts";

const { values: f } = parseArgs({ strict: true, options: {
  folder: { type: "string" }, contracts: { type: "string" }, file: { type: "string" }, "terms-json": { type: "string" },
  "extract-model": { type: "string", default: "local/qwen2.5-3b" }, "extract-retries": { type: "string", default: "1" }, gateway: { type: "string", default: "http://127.0.0.1:8720" },
  "key-file": { type: "string", default: fileURLToPath(new URL("../../../test-console/local-gateway-key.txt", import.meta.url)) }, "key-env": { type: "string" },
  via: { type: "string", default: "direct" }, "actus-url": { type: "string" }, "mentor-url": { type: "string" }, "mentor-key-env": { type: "string", default: "ACTUS_MENTOR_API_KEY" },
  out: { type: "string", default: "loan_schedules.csv" }, "postman-out": { type: "string" }, "timeout-sec": { type: "string", default: "120" },
} });
const fail = (m: string): never => { console.error(`contract-cashflows: ${m}`); process.exit(2); };
if (!f.folder || !existsSync(f.folder)) fail("--folder <existing data folder> is required");
if (f.via !== "direct" && f.via !== "mentor") fail("--via must be direct or mentor");
if (!/^[\w.-]+\/[\w.:-]+$/.test(f["extract-model"]!)) fail("--extract-model must look like provider/name");
if (f["terms-json"] && !f.file) fail("--terms-json needs --file (one document)");
if (/[\\/]/.test(f.out!)) fail("--out is a file name inside --folder");
const timeoutMs = Number(f["timeout-sec"]) * 1000;
const extractRetries = Number(f["extract-retries"]);
if (!Number.isInteger(extractRetries) || extractRetries < 0 || extractRetries > 3) fail("--extract-retries must be 0 to 3");
if (!(timeoutMs > 0)) fail("--timeout-sec must be a positive number");
const actusUrl = f.via === "direct" ? (f["actus-url"] || process.env.ACTUS_URL || fail("--actus-url (or ACTUS_URL) is required for --via direct")) : "";
const mentorUrl = f.via === "mentor" ? (f["mentor-url"] || process.env.ACTUS_MENTOR_URL || fail("--mentor-url (or ACTUS_MENTOR_URL) is required for --via mentor")) : "";
const mentorKey = process.env[f["mentor-key-env"]!] || undefined;

const docs = f.file ? [f.file] : (() => { const dir = f.contracts ?? join(f.folder!, "contracts"); if (!existsSync(dir)) fail(`no contracts folder at ${dir}`); return readdirSync(dir).filter((n) => /\.(md|txt)$/i.test(n)).sort().map((n) => join(dir, n)); })();
if (!docs.length) fail("no .md or .txt documents found");
const needModel = !f["terms-json"];
let chat: ReturnType<typeof gatewayChat> | null = null;
if (needModel) {
  const key = f["key-env"] ? process.env[f["key-env"]] : (() => { try { return readFileSync(f["key-file"]!, "utf8").trim(); } catch { return ""; } })();
  if (!key) fail(f["key-env"] ? `environment variable ${f["key-env"]} is empty` : `no gateway key in ${f["key-file"]}`);
  chat = gatewayChat({ url: f.gateway!, key: key!, timeoutMs });
}

async function one(path: string): Promise<{ id: string; rows: (string | number)[][]; payload: Payload } | null> {
  const id = basename(path, extname(path)).toUpperCase().replace(/[^A-Z0-9]+/g, "-");
  const doc = readFileSync(path, "utf8");
  console.log(`\n== ${basename(path)}  (Contract ID ${id})`);
  let terms: Terms | null = null;
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [{ role: "system", content: TERMS_SYSTEM }, { role: "user", content: doc }];
  for (let attempt = 0; attempt <= (f["terms-json"] ? 0 : extractRetries); attempt++) {
    let t: Terms;
    try {
      if (f["terms-json"]) t = parseTerms(f["terms-json"]);
      else {
        const reply = await chat!(messages, f["extract-model"]!);
        console.log(`TERMS     ${attempt ? "re-read" : "read"} by ${reply.model ?? f["extract-model"]}${reply.zone ? ` (zone ${reply.zone})` : ""}`);
        messages.push({ role: "assistant", content: reply.text });
        t = parseTerms(reply.text);
      }
      checkTerms(t);
    } catch (e) {
      console.log(`CHECK     FAIL  ${(e as Error).message}`);
      if (f["terms-json"] || attempt === extractRetries) { console.log("REFUSED   no usable terms; nothing was sent to ACTUS"); return null; }
      messages.push({ role: "user", content: `That is not usable: ${(e as Error).message}. Return the JSON terms again, in a \`\`\`json block only.` });
      continue;
    }
    console.log(`TERMS     ${t.contractType} ${t.notional} ${t.currency} at ${(t.annualRate * 100).toFixed(2)}% from ${t.startDate} to ${maturityOf(t)}${t.dayCount ? ` (${t.dayCount})` : ""}`);
    const missing = termsInDocument(t, doc);
    for (const m of missing) console.log(`CHECK     FAIL  ${m}`);
    if (!missing.length) { terms = t; break; }
    if (f["terms-json"] || attempt === extractRetries) { console.log("REFUSED   a term is not in the document; nothing was sent to ACTUS"); return null; }
    // The failed checks go back to the model (they hold only the model's own values and rule names, no document text).
    messages.push({ role: "user", content: `These terms failed the check against the document: ${missing.join("; ")}. Re-read the document and return corrected JSON terms, in a \`\`\`json block only. Remember: equal instalments of principal and interest = "ANN"; one repayment of principal at the end = "PAM"; leave maturityDate out unless the document states the final date.` });
  }
  if (!terms) return null;
  terms.id = id;
  console.log("CHECK     pass  every term is in the document");
  let payload: Payload, results: ActusResult[];
  try {
    if (f.via === "direct") { payload = buildContract(terms); results = await runDirect(actusUrl, payload, timeoutMs); }
    else {
      const built = await mentorBuild(mentorUrl, mentorKey, terms, timeoutMs);
      console.log(`MENTOR    built the contract (route ${built.route}, hallucination check ${built.hallucinationCheck})`);
      payload = built.payload;
      const intent = intentChecks(payload, terms);
      for (const [n, ok] of intent) console.log(`CHECK     ${ok ? "pass" : "FAIL"}  Mentor's contract: ${n}`);
      if (intent.some(([, ok]) => !ok)) { console.log("REFUSED   Mentor's contract differs from the terms; not run"); return null; }
      (payload.contracts[0] as Record<string, unknown>).contractID = id;
      results = await mentorRun(mentorUrl, mentorKey, payload, timeoutMs);
    }
  } catch (e) { console.log(`ERROR     ${(e as Error).message}`); return null; }
  const r = results?.[0];
  const checks = scheduleChecks(r, terms.notional, maturityOf(terms));
  for (const [n, ok] of checks) console.log(`CHECK     ${ok ? "pass" : "FAIL"}  ${n}`);
  if (!r || checks.some(([, ok]) => !ok)) { console.log("REFUSED   ACTUS's schedule failed a check; not saved"); return null; }
  r.contractID = id;
  const rows = scheduleRows(r, basename(path));
  const interest = r.events.filter((e) => e.type === "IP").reduce((n, e) => n + Math.abs(e.payoff), 0);
  console.log(`SCHEDULE  ${rows.length} events; interest ${interest.toFixed(2)}; total repaid ${(terms.notional + interest).toFixed(2)}`);
  return { id, rows, payload };
}

const done: { id: string; rows: (string | number)[][]; payload: Payload }[] = [];
for (const d of docs) { const r = await one(d); if (r) done.push(r); }
if (!done.length) { console.log("\nNothing saved."); process.exit(1); }
const out = join(f.folder!, f.out!);
const cell = (v: unknown) => { const x = String(v ?? ""); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
const ids = new Set(done.map((d) => d.id));
const kept = existsSync(out) ? readFileSync(out, "utf8").trim().split("\n").slice(1).filter((l) => l && !ids.has(l.split(",")[0])) : [];
writeFileSync(out, [SCHEDULE_HEADER.join(","), ...kept, ...done.flatMap((d) => d.rows.map((x) => x.map(cell).join(",")))].join("\n") + "\n");
console.log(`\nSAVED     ${out} (${done.length} contract(s) written, ${kept.length} earlier row(s) kept)`);
if (f["postman-out"]) {
  const base = f.via === "direct" ? new URL(actusUrl).origin : new URL(mentorUrl).origin, path = f.via === "direct" ? "/eventsBatch" : "/run-contract";
  writeFileSync(f["postman-out"], JSON.stringify({ info: { name: "ChainAim ACTUS — contracts", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json", description: "Loan terms only (no books). Made by services/analyst/scripts/contract-cashflows.ts." },
    variable: [{ key: "base", value: base }],
    item: done.map((d) => ({ name: d.id, request: { method: "POST", header: [{ key: "Content-Type", value: "application/json" }, ...(f.via === "mentor" ? [{ key: "X-API-Key", value: "{{mentorApiKey}}" }] : [])],
      body: { mode: "raw", raw: JSON.stringify(f.via === "direct" ? d.payload : { contract: d.payload }, null, 2), options: { raw: { language: "json" } } },
      url: { raw: `{{base}}${path}`, host: ["{{base}}"], path: path.split("/").filter(Boolean) } } })) }, null, 2) + "\n");
  console.log(`POSTMAN   ${f["postman-out"]}`);
}
