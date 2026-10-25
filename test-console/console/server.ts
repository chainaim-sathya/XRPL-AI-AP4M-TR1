/**
 * Local test console for the ChainAim stack running in Docker on this PC.
 * Serves one page and forwards its calls: scan, mask and chat to the gateway
 * (adding the local test key), unpaid calls to the paywall (to show the 402),
 * the spy stand-in's record of what left, the last ledger lines, and the
 * gateway's model list with this console's default model (the page's pick list).
 *
 *   node server.ts [--default-model ID] [--models-file PATH] [--port N] [--gateway URL] [--paywall URL] [--spy URL]
 *
 *   --default-model ID  model the pick list starts on until you pick another
 *                       (default: defaultModel in --models-file; chainaim/auto = let the gateway rank)
 *   --models-file PATH  local model registry       (default ../../config/local-models.json, from this folder)
 *   --generated-summary PATH  output budget of the last local-model switch (default ../../config/generated/summary.json)
 *   --port N            console port                (default 8730)
 *   --gateway URL       gateway                     (default http://127.0.0.1:8720)
 *   --paywall URL       paywall                     (default http://127.0.0.1:8080)
 *   --spy URL           stand-in's record           (default http://127.0.0.1:5004)
 *   --view-max N        HTML pages from answers kept in memory for "Open page" links (default 20; oldest dropped first)
 *   --view-ttl-min N    minutes a page link stays valid  (default 60)
 *   --view-max-bytes N  largest page accepted         (default 1000000)
 *   --view-script-src S space-separated https origins a page may load scripts and styles from
 *                       (default "https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com")
 *
 *   --data-config PATH  data folders the page may browse and read (default ../../config/data-sources.json):
 *                       allowedRoots, defaultFolder, defaultMode (whole|pick), extensions, maxBytes, exclude, maxFiles,
 *                       hideFolders (folder-name patterns never listed; default ["_*"], which hides the analyst's
 *                       work folder). Re-read on every call.
 *   --analyst URL       the analyst for "03 Private chat + analysis" (default http://127.0.0.1:8740; services/analyst,
 *                       started by start-analyst.cmd). Only its known routes are forwarded, as JSON.
 *   Ask across files ("Ask across files" box on the chat tab): POST /crossask {folder, question, model?, answerModel?, phrase?, sql?}
 *   runs services/analyst/src/crossask.ts here: the analyst finds how the folder's CSV/TSV files relate, the model
 *   (through the gateway, with the local key) writes one SELECT from the headers only, the analyst runs it, and with
 *   phrase "llm" the model words the answer from the result (masked by the gateway).
 *   --crossask-timeout-sec N   per call to the analyst or the gateway (default 300)
 *   --crossask-sql-retries N   times the model may fix a failed query (default 1)
 *   --crossask-answer-rows N   result rows sent for the worded answer (default 50)
 *
 *   Paid chat ("Pay with Crossmark" box on the chat tab): the browser pays the paywall's chat price from its own
 *   Crossmark wallet with the web page's bundle (services/web, payAndChat). This server serves the bundle and
 *   relays /paid/chat to the PAYWALL with the payment header; it never adds the gateway key there and logs
 *   neither the text nor the payment.
 *   --wallet-bundle PATH  the browser payment bundle (default ../../services/web/public/wallet.js;
 *                         build it with npm --prefix services/web run build:wallet)
 *   --paid-timeout-sec N  how long a paid chat may take, quote, settle and answer together (default 240)
 *
 *   Pages are served at /view/<id> with a sandbox Content-Security-Policy: their scripts run in an opaque
 *   origin and connect-src is 'none', so model-written HTML cannot call this console, the gateway or any
 *   other address. Pages live in memory only (they can hold statement data) and vanish on restart.
 *
 *   node server.ts  ->  http://127.0.0.1:8730
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { NETWORKS } from "../../services/web/src/balance.ts";
import { analystClient, crossAsk, gatewayChat } from "../../services/analyst/src/crossask.ts";

const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  options: {
    "default-model": { type: "string" },
    "models-file": { type: "string", default: fileURLToPath(new URL("../../config/local-models.json", import.meta.url)) },
    "generated-summary": { type: "string", default: fileURLToPath(new URL("../../config/generated/summary.json", import.meta.url)) },
    port: { type: "string", default: "8730" },
    gateway: { type: "string", default: "http://127.0.0.1:8720" },
    paywall: { type: "string", default: "http://127.0.0.1:8080" },
    spy: { type: "string", default: "http://127.0.0.1:5004" },
    "data-config": { type: "string", default: fileURLToPath(new URL("../../config/data-sources.json", import.meta.url)) },
    analyst: { type: "string", default: "http://127.0.0.1:8740" },
    "view-max": { type: "string", default: "20" },
    "view-ttl-min": { type: "string", default: "60" },
    "view-max-bytes": { type: "string", default: "1000000" },
    "view-script-src": { type: "string", default: "https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com" },
    "wallet-bundle": { type: "string", default: fileURLToPath(new URL("../../services/web/public/wallet.js", import.meta.url)) },
    "paid-timeout-sec": { type: "string", default: "240" },
    "crossask-timeout-sec": { type: "string", default: "300" },
    "crossask-sql-retries": { type: "string", default: "1" },
    "crossask-answer-rows": { type: "string", default: "50" },
  },
});
function positiveInt(name: "view-max" | "view-ttl-min" | "view-max-bytes" | "paid-timeout-sec" | "crossask-timeout-sec" | "crossask-sql-retries" | "crossask-answer-rows", min = 1): number {
  const n = Number(flags[name]);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be a positive integer, got ${flags[name]}`);
  return n;
}
const VIEW_MAX = positiveInt("view-max");
const VIEW_TTL_MS = positiveInt("view-ttl-min") * 60_000;
const VIEW_MAX_BYTES = positiveInt("view-max-bytes");
const VIEW_SOURCES = flags["view-script-src"]!.split(/\s+/).filter(Boolean);
const PAID_TIMEOUT_MS = positiveInt("paid-timeout-sec") * 1000;
const WALLET_BUNDLE = flags["wallet-bundle"]!;
const CROSSASK_TIMEOUT_MS = positiveInt("crossask-timeout-sec") * 1000;
const CROSSASK_RETRIES = positiveInt("crossask-sql-retries", 0);
const CROSSASK_ROWS = positiveInt("crossask-answer-rows");
/** Paywall response headers the paid chat passes back: the price, the receipt, retry advice and the gateway's own. */
const PAID_PASS_BACK = /^(payment-required|payment-response|retry-after|x-chainaim-[a-z-]+)$/;
for (const s of VIEW_SOURCES) {
  if (!URL.canParse(s) || new URL(s).protocol !== "https:" || new URL(s).origin !== s.replace(/\/+$/, "")) throw new Error(`--view-script-src entries must be https origins like https://cdn.jsdelivr.net, got ${s}`);
}
for (const name of ["gateway", "paywall", "spy", "analyst"] as const) {
  if (!URL.canParse(flags[name]!)) throw new Error(`--${name} must be a URL, got ${flags[name]}`);
}
const PORT = Number(flags.port);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error(`--port must be 1 to 65535, got ${flags.port}`);
/** The registry's defaultModel, so the pick list follows config/local-models.json; chainaim/auto when it cannot be read. */
function registryDefault(path: string): string {
  try {
    const text = readFileSync(path, "utf8");
    const id = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).defaultModel;
    return typeof id === "string" && id ? id : "chainaim/auto";
  } catch {
    return "chainaim/auto";
  }
}
const DEFAULT_MODEL = (flags["default-model"] ?? registryDefault(flags["models-file"]!)).trim();
/** The output budget the last switch gave the gateway (config/generated/summary.json), or null outside the local-model mode. Read per call, so a switch needs no console restart. */
function generatedMaxOutput(): number | null {
  try {
    const text = readFileSync(flags["generated-summary"]!, "utf8");
    const n = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).maxOutputTokens;
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

const KEY = readFileSync(new URL("../local-gateway-key.txt", import.meta.url), "utf8").trim();
const GATEWAY = flags.gateway!.replace(/\/+$/, "");
const PAYWALL = flags.paywall!.replace(/\/+$/, "");
const SPY = flags.spy!.replace(/\/+$/, "");
const PAGE = new URL("./index.html", import.meta.url);

const ANALYST = flags.analyst!.replace(/\/+$/, "");
const ANALYST_ROUTES = new Set(["profile", "recipe", "analyze", "status", "evidence", "verify", "relations", "sql"]);
const ROUTES: Record<string, string> = { scan: "/v1/privacy/scan", mask: "/v1/privacy/mask", chat: "/v1/chat/completions" };

// "Open page" links: HTML pages found in model answers, kept in memory only, served sandboxed.
const views = new Map<string, { html: string; at: number }>();
function pruneViews(now = Date.now()): void {
  for (const [id, v] of views) if (now - v.at > VIEW_TTL_MS) views.delete(id);
  while (views.size > VIEW_MAX) views.delete(views.keys().next().value as string);
}
const VIEW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VIEW_CSP = [
  "sandbox allow-scripts", // opaque origin: no access to this console's origin, storage or cookies
  "default-src 'none'",
  `script-src 'unsafe-inline' ${VIEW_SOURCES.join(" ")}`,
  `style-src 'unsafe-inline' ${VIEW_SOURCES.join(" ")} https://fonts.googleapis.com`,
  "font-src https://fonts.gstatic.com data:",
  "img-src data: blob:",
  "connect-src 'none'", // no fetch/XHR/WebSocket: the page cannot reach the console, the gateway or the internet
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");
const viewHeaders = { "content-security-policy": VIEW_CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };

// ---- From data folder ------------------------------------------------------------------------------
// The page only NAMES a folder or file; this server decides. Only paths inside allowedRoots (the data config, re-read on
// every call so edits need no restart) are listed or read, after resolving links. Read-only; nothing is created.
type DataConfig = { allowedRoots: string[]; defaultFolder: string; extensions: string[]; maxBytes: Record<string, number>; exclude: RegExp[]; excludeText: string[]; maxFiles: number; defaultMode: "whole" | "pick"; hideFolders: RegExp[] };
const fold = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);
function within(child: string, root: string): boolean {
  const r = relative(fold(root), fold(child));
  return r === "" || (r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r));
}
const globToRe = (g: string): RegExp => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
function readDataConfig(): { config?: DataConfig; error?: string } {
  let raw: Record<string, any>;
  try {
    const text = readFileSync(flags["data-config"]!, "utf8");
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    return { error: `Data folders are off: cannot read ${flags["data-config"]} (${(e as Error).message}). Copy config/data-sources.example.json to config/data-sources.json.` };
  }
  const roots: string[] = Array.isArray(raw.allowedRoots) ? raw.allowedRoots.filter((r: unknown) => typeof r === "string" && isAbsolute(r)).map((r: string) => resolve(r)) : [];
  if (!roots.length) return { error: "Data folders are off: allowedRoots must list at least one absolute folder." };
  const defaultFolder = typeof raw.defaultFolder === "string" && isAbsolute(raw.defaultFolder) ? resolve(raw.defaultFolder) : roots[0];
  if (!roots.some((r) => within(defaultFolder, r))) return { error: `Data folders are off: defaultFolder ${defaultFolder} is not inside allowedRoots.` };
  const extensions: string[] = (Array.isArray(raw.extensions) ? raw.extensions : [".csv", ".tsv", ".txt", ".pdf"]).map((e: unknown) => String(e).toLowerCase());
  const maxBytes: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw.maxBytes ?? {})) if (Number.isInteger(v) && (v as number) > 0) maxBytes[k.toLowerCase()] = v as number;
  maxBytes["*"] ??= 2_000_000;
  const excludeText: string[] = Array.isArray(raw.exclude) ? raw.exclude.map(String) : [];
  const maxFiles = Number.isInteger(raw.maxFiles) && raw.maxFiles > 0 ? raw.maxFiles : 500;
  const defaultMode = raw.defaultMode === "pick" ? "pick" : "whole"; // whole: every file in the folder goes with each question
  const hideFolders = (Array.isArray(raw.hideFolders) ? raw.hideFolders.map(String) : ["_*"]).map(globToRe); // e.g. the analyst's _analyst work folder
  return { config: { allowedRoots: roots, defaultFolder, extensions, maxBytes, exclude: excludeText.map(globToRe), excludeText, maxFiles, defaultMode, hideFolders } };
}
class DataError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
/** The real location of a requested path, which must be inside an allowed root. The lexical check runs first, so a path outside the roots is refused without touching the disk; the real-path check then catches links that lead out. */
async function insideRoots(p: string, cfg: DataConfig): Promise<string> {
  if (!p || !isAbsolute(p)) throw new DataError(400, "path must be an absolute path");
  const asked = resolve(p);
  if (!cfg.allowedRoots.some((r) => within(asked, r))) throw new DataError(403, "outside the allowed data folders (allowedRoots in the data config)");
  let real: string;
  try { real = await realpath(asked); } catch { throw new DataError(404, `not found: ${asked}`); }
  for (const r of cfg.allowedRoots) {
    let rootReal: string;
    try { rootReal = await realpath(r); } catch { continue; }
    if (within(real, rootReal)) return real;
  }
  throw new DataError(403, "this path leads outside the allowed data folders (a link?)");
}
const usableName = (file: string, cfg: DataConfig): boolean => cfg.extensions.includes(extname(file).toLowerCase()) && !cfg.exclude.some((re) => re.test(basename(file)));
const capFor = (file: string, cfg: DataConfig): number => cfg.maxBytes[extname(file).toLowerCase()] ?? cfg.maxBytes["*"];
/** Only this console's own address may use the data routes, so a site reached through DNS rebinding cannot read files. */
const hostOk = (req: IncomingMessage): boolean => { const h = (req.headers.host ?? "").toLowerCase(); return h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}`; };
const dataHeaders = { "x-content-type-options": "nosniff", "cache-control": "no-store" };
function dataJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", ...dataHeaders });
  res.end(JSON.stringify(body));
}
async function isFolder(p: string): Promise<boolean> { try { return (await stat(p)).isDirectory(); } catch { return false; } }

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://console");
    const [, api, name] = url.pathname.split("/");
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync(PAGE));
      return;
    }
    // The pick list: every model the gateway serves now, plus this console's default.
    if (api === "gateway" && name === "models" && req.method === "GET") {
      const r = await fetch(GATEWAY + "/v1/models", { headers: { authorization: `Bearer ${KEY}` } });
      const body = (await r.json().catch(() => null)) as { data?: { id?: unknown; context_length?: unknown }[] } | null;
      const data = body?.data ?? [];
      const models = data.map((m) => m.id).filter((id): id is string => typeof id === "string");
      // Context length per model and the gateway's output budget let the page warn before a prompt is too big.
      const limits = Object.fromEntries(data.filter((m) => typeof m.id === "string" && typeof m.context_length === "number").map((m) => [m.id, m.context_length]));
      json(res, 200, { status: r.status, defaultModel: DEFAULT_MODEL, models, limits, maxOutputTokens: generatedMaxOutput() });
      return;
    }
    if (api === "gateway" && req.method === "POST" && ROUTES[name]) {
      const r = await fetch(GATEWAY + ROUTES[name], {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: await readBody(req),
      });
      const headers = Object.fromEntries([...r.headers].filter(([k]) => k.startsWith("x-chainaim")));
      json(res, 200, { status: r.status, headers, body: await r.json().catch(() => null) });
      return;
    }
    if (api === "paywall" && ROUTES[name]) {
      const body = name === "chat" ? { messages: [{ role: "user", content: "hi" }] } : { text: "hi" };
      const r = await fetch(PAYWALL + ROUTES[name], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const header = r.headers.get("payment-required");
      const required = header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : null;
      json(res, 200, {
        status: r.status,
        accepts: required?.accepts?.map((a: Record<string, any>) => ({ price: Number(a.amount), network: a.network, asset: a.asset, issuer: a.extra?.issuer, payTo: a.payTo, invoiceId: a.extra?.invoiceId })) ?? [],
        bazaar: Boolean(required?.extensions?.bazaar),
        body: header ? null : await r.json().catch(() => null),
      });
      return;
    }
    // Store one HTML page from an answer. JSON only, so a cross-site page cannot post here without a CORS preflight (which this server never grants).
    if (api === "view" && !name && req.method === "POST") {
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return json(res, 415, { error: "send application/json" });
      const raw = await readBody(req);
      if (Buffer.byteLength(raw) > VIEW_MAX_BYTES + 1024) return json(res, 413, { error: `page over --view-max-bytes (${VIEW_MAX_BYTES})` });
      let html: unknown;
      try { html = JSON.parse(raw).html; } catch { return json(res, 400, { error: 'body must be JSON {"html": "..."}' }); }
      if (typeof html !== "string" || !html.includes("<")) return json(res, 400, { error: "html must be a string of HTML" });
      if (Buffer.byteLength(html) > VIEW_MAX_BYTES) return json(res, 413, { error: `page over --view-max-bytes (${VIEW_MAX_BYTES})` });
      pruneViews();
      const id = randomUUID();
      views.set(id, { html, at: Date.now() });
      pruneViews();
      json(res, 200, { url: `/view/${id}`, expiresInMin: VIEW_TTL_MS / 60_000 });
      return;
    }
    if (api === "view" && name && req.method === "GET") {
      pruneViews();
      const page = VIEW_ID.test(name) ? views.get(name) : undefined;
      if (!page) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...viewHeaders });
        res.end("This page has expired or the test console was restarted. Ask the question again to get a new link.");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...viewHeaders });
      res.end(page.html);
      return;
    }
    // From data folder: config, sub-folders, files, one file. GET only, read-only, confined to allowedRoots.
    if (api === "data" && req.method === "GET") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      const { config, error } = readDataConfig();
      if (name === "config") {
        return dataJson(res, 200, config
          ? { enabled: true, allowedRoots: config.allowedRoots, defaultFolder: config.defaultFolder, defaultExists: await isFolder(config.defaultFolder), extensions: config.extensions, maxBytes: config.maxBytes, exclude: config.excludeText, maxFiles: config.maxFiles, defaultMode: config.defaultMode }
          : { enabled: false, error });
      }
      if (!config) return dataJson(res, 503, { error });
      try {
        const p = url.searchParams.get("path") ?? "";
        if (name === "folders") {
          if (!p) return dataJson(res, 200, { path: "", parent: null, folders: config.allowedRoots.map((r) => ({ name: r, path: r })) });
          const dir = await insideRoots(p, config);
          if (!(await isFolder(dir))) throw new DataError(400, "not a folder");
          const folders = (await readdir(dir, { withFileTypes: true }))
            .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !config.hideFolders.some((re) => re.test(e.name)))
            .map((e) => ({ name: e.name, path: join(dir, e.name) }))
            .sort((a, b) => a.name.localeCompare(b.name));
          const up = dirname(dir);
          return dataJson(res, 200, { path: dir, parent: up !== dir && config.allowedRoots.some((r) => within(up, r)) ? up : "", folders });
        }
        if (name === "files") {
          const dir = await insideRoots(p, config);
          if (!(await isFolder(dir))) throw new DataError(400, "not a folder");
          const entries = (await readdir(dir, { withFileTypes: true }))
            .filter((e) => e.isFile() && usableName(e.name, config))
            .sort((a, b) => a.name.localeCompare(b.name));
          const files = [];
          for (const e of entries.slice(0, config.maxFiles)) {
            const full = join(dir, e.name);
            const st = await stat(full);
            files.push({ name: e.name, path: full, ext: extname(e.name).toLowerCase(), size: st.size, modified: st.mtime.toISOString(), tooBig: st.size > capFor(e.name, config) });
          }
          return dataJson(res, 200, { path: dir, files, truncated: entries.length > config.maxFiles, maxFiles: config.maxFiles });
        }
        if (name === "file") {
          const file = await insideRoots(p, config);
          const st = await stat(file);
          if (!st.isFile()) throw new DataError(400, "not a file");
          if (!usableName(file, config)) throw new DataError(403, `not an allowed file type (${config.extensions.join(", ")}) or excluded`);
          if (st.size > capFor(file, config)) throw new DataError(413, `larger than the ${extname(file)} limit (${capFor(file, config)} bytes)`);
          res.writeHead(200, { "content-type": extname(file).toLowerCase() === ".pdf" ? "application/pdf" : "text/plain; charset=utf-8", ...dataHeaders });
          res.end(await readFile(file));
          return;
        }
        return dataJson(res, 404, { error: "unknown data route" });
      } catch (e) {
        if (e instanceof DataError) return dataJson(res, e.status, { error: e.message });
        throw e;
      }
    }
    // 03 Private chat + analysis: forwarded to the analyst (compute only, 127.0.0.1, no model calls). Known routes only, JSON only.
    if (api === "analyst") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      const route = name ?? "";
      if (!(req.method === "GET" ? route === "healthz" : req.method === "POST" && ANALYST_ROUTES.has(route))) return dataJson(res, 404, { error: "unknown analyst route" });
      if (req.method === "POST" && !/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return dataJson(res, 415, { error: "send application/json" });
      let r: Response;
      try {
        r = await fetch(`${ANALYST}/${route}`, req.method === "POST" ? { method: "POST", headers: { "content-type": "application/json" }, body: await readBody(req) } : {});
      } catch {
        return dataJson(res, 503, { error: `the analyst is not running at ${ANALYST}: start test-console\\start-analyst.cmd and keep its window open` });
      }
      res.writeHead(r.status, { "content-type": "application/json", ...dataHeaders });
      res.end(await r.text());
      return;
    }
    // Ask across files: relations and query on this PC (analyst), the model through the gateway (headers first, the result only with phrase llm).
    if (api === "crossask" && !name && req.method === "POST") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      let b: Record<string, unknown>;
      try { b = JSON.parse(await readBody(req)); } catch { return dataJson(res, 400, { error: "body must be JSON" }); }
      const model = typeof b.model === "string" && b.model ? b.model : DEFAULT_MODEL;
      if (!/^[\w.-]+\/[\w.:-]+$/.test(model)) return dataJson(res, 400, { error: `model must look like provider/name, got ${model}` });
      if (typeof b.folder !== "string" || typeof b.question !== "string" || !b.question.trim()) return dataJson(res, 400, { error: "folder and question are required" });
      const phrase = b.phrase === "none" ? "none" : "llm";
      const answerModel = typeof b.answerModel === "string" && b.answerModel ? b.answerModel : undefined;
      if (answerModel && !/^[\w.-]+\/[\w.:-]+$/.test(answerModel)) return dataJson(res, 400, { error: `answerModel must look like provider/name, got ${answerModel}` });
      try {
        const out = await crossAsk({ folder: b.folder, question: b.question, model, answerModel, phrase, sqlRetries: CROSSASK_RETRIES, answerMaxRows: CROSSASK_ROWS, sql: typeof b.sql === "string" && b.sql.trim() ? b.sql : undefined },
          { analyst: analystClient(ANALYST, CROSSASK_TIMEOUT_MS), chat: gatewayChat({ url: GATEWAY, key: KEY, timeoutMs: CROSSASK_TIMEOUT_MS }) });
        return dataJson(res, 200, out);
      } catch (e) {
        return dataJson(res, 502, { error: (e as Error).message });
      }
    }
    // ---- Paid chat ---------------------------------------------------------------------------------------------
    // The browser bundle that pays from the visitor's Crossmark wallet (services/web/public/wallet.js).
    if (api === "wallet.js" && req.method === "GET") {
      let js: Buffer;
      try { js = readFileSync(WALLET_BUNDLE); } catch { return json(res, 404, { error: `the wallet bundle is not at ${WALLET_BUNDLE}: run npm --prefix services/web run build:wallet` }); }
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
      res.end(js);
      return;
    }
    // What the paid chat pays on, from the paywall's own chat quote, with the public ledger server for that network.
    if (api === "paid" && name === "network" && req.method === "GET") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      const r = await fetch(PAYWALL + ROUTES.chat, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }), signal: AbortSignal.timeout(8000) });
      const header = r.headers.get("payment-required");
      if (r.status !== 402 || !header) return json(res, 503, { error: `the paywall did not quote a chat price (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}` });
      const a = JSON.parse(Buffer.from(header, "base64").toString("utf8")).accepts?.[0] as Record<string, any> | undefined;
      const known = Object.entries(NETWORKS).find(([, n]) => n.caip2 === a?.network);
      if (!a || !known || typeof a.extra?.issuer !== "string" || typeof a.asset !== "string") return json(res, 502, { error: `the paywall quotes a network or shape this console does not know (${a?.network ?? "none"})` });
      json(res, 200, { name: known[0], caip2: known[1].caip2, wsUrl: known[1].wsUrl, asset: a.asset, issuer: a.extra.issuer, payTo: a.payTo, price: Number(a.amount) });
      return;
    }
    // The paid chat itself, relayed to the paywall (not the gateway, and without the gateway key) with the payment header.
    if (api === "paid" && name === "chat" && req.method === "POST") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return json(res, 415, { error: { message: "send application/json" } });
      const signature = req.headers["payment-signature"];
      if (Array.isArray(signature)) return json(res, 400, { error: { message: "send one payment-signature header" } });
      const body = await readBody(req);
      const started = Date.now();
      let r: Response;
      try {
        r = await fetch(PAYWALL + ROUTES.chat, {
          method: "POST",
          headers: { "content-type": "application/json", ...(signature ? { "payment-signature": signature } : {}) },
          body,
          signal: AbortSignal.timeout(PAID_TIMEOUT_MS),
        });
      } catch {
        // Once a payment was forwarded, the paywall may have settled it before the connection failed.
        return json(res, 502, { error: { message: signature ? "The connection to the paywall failed after your payment was sent. Check your wallet's recent transactions before trying again." : "Could not reach the paywall. You were not charged." } });
      }
      const headers: Record<string, string> = { "content-type": r.headers.get("content-type") ?? "application/json", "cache-control": "no-store" };
      r.headers.forEach((value, key) => { if (PAID_PASS_BACK.test(key)) headers[key] = value; });
      let out: Buffer;
      try {
        out = Buffer.from(await r.arrayBuffer());
      } catch {
        // The paywall settles before it streams the answer, so a paid body lost here may already be paid for.
        const receipt = headers["payment-response"];
        res.writeHead(502, { "content-type": "application/json", ...(receipt ? { "payment-response": receipt } : {}) });
        res.end(JSON.stringify({ error: { message: signature ? "The answer was lost after your payment went through. Check your wallet's recent transactions before trying again." : "Could not read the paywall's answer. You were not charged." } }));
        return;
      }
      // Status and timing only: never the text, the payment header or the receipt.
      console.log(JSON.stringify({ ts: new Date().toISOString(), route: "paid-chat", status: r.status, withPayment: signature !== undefined, ms: Date.now() - started }));
      res.writeHead(r.status, headers);
      res.end(out);
      return;
    }
    if (api === "leaving") {
      json(res, 200, await (await fetch(SPY)).json());
      return;
    }
    if (api === "ledger") {
      execFile("docker", ["exec", "ca-gateway", "sh", "-c", "tail -n 6 /data/ledger/*.jsonl"], (err, out) => {
        const lines = err ? [] : out.trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return l; } });
        json(res, 200, { lines });
      });
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 502, { error: (e as Error).message });
  }
}).listen(PORT, "127.0.0.1", async () => {
  console.log(`[test-console] http://127.0.0.1:${PORT}  default model: ${DEFAULT_MODEL}`);
  const { config, error } = readDataConfig();
  if (!config) console.log(`[test-console] ${error}`);
  else console.log(`[test-console] data folders: ${config.allowedRoots.join(", ")}; default ${config.defaultFolder}${(await isFolder(config.defaultFolder)) ? "" : "  (NOT FOUND: create it)"}`);
});
