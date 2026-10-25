/**
 * chainaim-client-privacy: the PC-side masking code, served on loopback only.
 *
 * It exists so hack/ap4m can mask, scan, restore and read documents over HTTP
 * instead of importing services/ (DESIGN/xrplh-18 section 3). The data never
 * leaves this computer: the server refuses to bind anything but loopback, and
 * nothing it handles is logged.
 *
 *   node services/client-privacy/src/main.ts --port 8787
 *
 * --port N              listen port                                 (default 8787)
 * --bind ADDR           loopback address only: 127.0.0.1 or ::1     (default 127.0.0.1)
 * --names on|off        mask labelled names                         (default on)
 * --doc-types LIST      comma-separated, or "all"                   (default all)
 * --table-format F      labelled | grid                             (default labelled)
 * --table-header H      first-row | none                            (default first-row)
 * --csv-delimiter C     one character                               (default ,)
 * --max-doc-mb N        largest document read                       (default 20)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseArgs } from "node:util";
import { BadRequest, DocumentRefused, INFO, postExtract, postMask, postRestore, postScan, type Settings } from "./routes.ts";
import { parseDocTypes, type TableFormat, type TableHeader } from "../../paywall/scripts/extract.ts";

/** Only these may be bound: anything else would put documents on the network. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
/** A masking request is text, not a document; 8 MiB is already generous. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8787" },
    bind: { type: "string", default: "127.0.0.1" },
    names: { type: "string", default: "on" },
    "doc-types": { type: "string", default: "all" },
    "table-format": { type: "string", default: "labelled" },
    "table-header": { type: "string", default: "first-row" },
    "csv-delimiter": { type: "string", default: "," },
    "max-doc-mb": { type: "string", default: "20" },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function onOff(name: string, raw: string): boolean {
  if (raw !== "on" && raw !== "off") fail(`--${name} must be on or off, got ${raw}`);
  return raw === "on";
}

const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`--port must be a port number, got ${values.port}`);
if (!LOOPBACK.has(values.bind!)) {
  fail(`--bind must be loopback (127.0.0.1 or ::1), got ${values.bind}: this service must never be reachable off this computer`);
}
const maxDocMb = Number(values["max-doc-mb"]);
if (!Number.isFinite(maxDocMb) || maxDocMb <= 0) fail(`--max-doc-mb must be above zero, got ${values["max-doc-mb"]}`);
if ([...values["csv-delimiter"]!].length !== 1) fail("--csv-delimiter must be exactly one character");

let types;
try {
  types = parseDocTypes(values["doc-types"]!);
} catch (error) {
  fail(`--doc-types: ${(error as Error).message}`);
}

const settings: Settings = {
  names: onOff("names", values.names!),
  extract: {
    types,
    tableFormat: values["table-format"] as TableFormat,
    tableHeader: values["table-header"] as TableHeader,
    csvDelimiter: values["csv-delimiter"],
    maxBytes: Math.floor(maxDocMb * 1024 * 1024),
  },
};

function send(response: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BadRequest(`the body is larger than ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  if (!size) throw new BadRequest("the body is empty");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadRequest("the body is not valid JSON");
  }
}

export const ROUTES = ["/mask", "/scan", "/restore", "/extract"] as const;

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = (request.url ?? "/").split("?")[0];

  if (request.method === "GET" && path === "/healthz") {
    return send(response, 200, { ok: true, service: "client-privacy", names: settings.names, ...INFO });
  }
  if (!ROUTES.includes(path as (typeof ROUTES)[number])) return send(response, 404, { error: "no_such_route", routes: ROUTES });
  if (request.method !== "POST") return send(response, 405, { error: "use_post" });

  try {
    const raw = await readBody(request);
    switch (path) {
      case "/mask":
        return send(response, 200, postMask(raw, settings));
      case "/scan":
        return send(response, 200, postScan(raw, settings));
      case "/restore":
        return send(response, 200, postRestore(raw));
      case "/extract":
        return send(response, 200, await postExtract(raw, settings));
    }
  } catch (error) {
    // Messages from these two name no value from the text or the document.
    if (error instanceof BadRequest) return send(response, 400, { error: "bad_request", detail: error.message });
    if (error instanceof DocumentRefused) return send(response, 422, { error: "document_refused", detail: error.message });
    // Anything else: say nothing about the payload.
    return send(response, 500, { error: "internal_error" });
  }
}

export const server = createServer((request, response) => {
  handle(request, response).catch(() => {
    if (!response.headersSent) send(response, 500, { error: "internal_error" });
    else response.end();
  });
});

// Only listen when run directly, so tests can import the server and pick a port.
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  server.listen(port, values.bind, () => {
    console.log(
      `[chainaim-client-privacy] listening on http://${values.bind}:${port}  names=${settings.names ? "on" : "off"} ` +
        `doc-types=${types.join(",")} max-doc=${maxDocMb}MB  (loopback only; nothing is logged)`,
    );
  });
}
