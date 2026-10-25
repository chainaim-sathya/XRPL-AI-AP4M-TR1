/**
 * F2: the buyer agent's prompt masking with the tenant's own Presidio
 * (scripts/prompt-scan.ts). A stand-in Presidio on a loopback port answers
 * /health, /supportedentities and /analyze from a fixed table of values, and
 * can be switched to fail (HTTP 500) or to return a malformed entity.
 * Nothing leaves the machine.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { REQUIRED_PRESIDIO_ENTITIES } from "../../gateway/src/privacy/entities.ts";
import { AskSession } from "../scripts/agent-core.ts";
import { AskRefused } from "../scripts/private-ask-core.ts";
import { presidioClient, PromptScan, type PromptScanner } from "../scripts/prompt-scan.ts";
import { close, listen } from "./stubs.ts";

/** What the stand-in finds: each value, wherever it appears, as this type. */
const TABLE: readonly [string, string][] = [
  ["Ravi Kumar", "PERSON"],
  // the gateway's start-up test sentence (DEFAULT_DETECTION.canary)
  ["Jane Roe", "PERSON"],
  ["jane.roe@example.com", "EMAIL_ADDRESS"],
  ["991122", "MEDICAL_RECORD"],
  ["12-3456-7890123-00", "BANK_ACCOUNT"],
  ["SAMPLEPERSON", "PERSON"],
  ["Rosewood", "STREET_ADDRESS"],
  ["14/03/1981", "DATE_OF_BIRTH"],
  ["diabetes", "HEALTH_TERM"],
  // an NLP model can tag a placeholder as a person; the self-check must not count it
  ["<C_PERSON_1>", "PERSON"],
];

type Mode = "ok" | "error" | "malformed";

function stubPresidio(supported: readonly string[] = REQUIRED_PRESIDIO_ENTITIES): { server: Server; state: { mode: Mode; analyzed: number } } {
  const state = { mode: "ok" as Mode, analyzed: 0 };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("content-type", "application/json");
    const path = new URL(req.url ?? "/", "http://presidio.local").pathname;
    if (path === "/health") return res.end("{}");
    if (path === "/supportedentities") return res.end(JSON.stringify(supported));
    if (path !== "/analyze") {
      res.statusCode = 404;
      return res.end("{}");
    }
    state.analyzed++;
    if (state.mode === "error") {
      res.statusCode = 500;
      return res.end("{}");
    }
    if (state.mode === "malformed") return res.end(JSON.stringify([{ entity_type: "PERSON", start: "x", end: 3, score: 0.9 }]));
    const text = String(JSON.parse(body).text);
    const out: { entity_type: string; start: number; end: number; score: number }[] = [];
    for (const [value, type] of TABLE) {
      for (let i = text.indexOf(value); i >= 0; i = text.indexOf(value, i + 1)) out.push({ entity_type: type, start: i, end: i + value.length, score: 0.85 });
    }
    res.end(JSON.stringify(out));
  });
  return { server, state };
}

const PROMPT = "Ask Ravi Kumar about his diabetes and mail ravi@example.org";

describe("F2 prompt masking with the tenant's Presidio", () => {
  const stub = stubPresidio();
  let url: string;

  before(async () => {
    url = await listen(stub.server);
  });
  after(async () => {
    await close(stub.server);
  });

  const scan = (scanner: PromptScanner, at = url, residual = true) =>
    new PromptScan({ scanner, names: true, residual, presidio: scanner === "client" ? undefined : presidioClient({ url: at, threshold: 0.4, timeoutMs: 2000, extraEntities: "default" }) });

  it("F2 both: a bare name is masked, a health term stays, the e-mail is masked, and the map puts them back", async () => {
    const r = await scan("both").mask(PROMPT);
    assert.ok(!r.masked.includes("Ravi"), r.masked);
    assert.ok(!r.masked.includes("ravi@example.org"), r.masked);
    assert.ok(r.masked.includes("<C_PERSON_1>"));
    assert.ok(r.masked.includes("diabetes"), "health terms stay, as on the gateway");
    assert.equal(r.map["<C_PERSON_1>"], "Ravi Kumar");
  });

  it("F2 client alone still misses a bare name (the gap Presidio closes)", async () => {
    const r = await scan("client").mask(PROMPT);
    assert.ok(r.masked.includes("Ravi Kumar"));
  });

  it("F2 presidio alone: what it does not find is caught by the residual check, and nothing is returned", async () => {
    // The stand-in has no entry for this e-mail, and the client patterns are off.
    await assert.rejects(scan("presidio").mask(PROMPT), (e: Error) => e instanceof AskRefused && /email 1/.test(e.message) && !e.message.includes("ravi@"));
  });

  it("F2 fail closed: Presidio answering HTTP 500 refuses the prompt, names no value, and sends nothing", async () => {
    stub.state.mode = "error";
    try {
      await assert.rejects(scan("both").mask(PROMPT), (e: Error) => e instanceof AskRefused && e.exitCode === 1 && /Presidio scanner at .+ failed \(presidio \/analyze: HTTP 500\); nothing was sent/.test(e.message) && !e.message.includes("Ravi"));
    } finally {
      stub.state.mode = "ok";
    }
  });

  it("F2 fail closed: a malformed entity refuses the prompt", async () => {
    stub.state.mode = "malformed";
    try {
      await assert.rejects(scan("both").mask(PROMPT), (e: Error) => e instanceof AskRefused && /malformed entity/.test(e.message));
    } finally {
      stub.state.mode = "ok";
    }
  });

  it("F2 fail closed: an unreachable Presidio refuses the prompt", async () => {
    const gone = createServer();
    const dead = await listen(gone);
    await close(gone);
    await assert.rejects(scan("both", dead).mask(PROMPT), (e: Error) => e instanceof AskRefused && /Presidio scanner at .+ failed/.test(e.message));
  });

  it("F2 the self-check does not count a span inside a placeholder", async () => {
    const r = await scan("both").mask("Dr. Ravi Kumar will call.");
    assert.equal(r.masked, "Dr. <C_PERSON_1> will call.");
  });

  it("F2 the residual check refuses a long digit run no detector found; off, it goes through", async () => {
    const prompt = "Reference 100000000017 for Ravi Kumar";
    await assert.rejects(scan("both").mask(prompt), (e: Error) => e instanceof AskRefused && /digits 1/.test(e.message) && !e.message.includes("100000000017"));
    const r = await scan("both", url, false).mask(prompt);
    assert.equal(r.masked, "Reference 100000000017 for <C_PERSON_1>");
  });

  it("F2 a scanner that uses Presidio needs a client", () => {
    assert.throws(() => new PromptScan({ scanner: "both", names: true, residual: true }), /needs a Presidio client/);
    assert.throws(() => new PromptScan({ scanner: "nope" as PromptScanner, names: true, residual: true }), /unknown prompt scanner/);
  });

  it("F2 the start-up check passes on a Presidio that finds the test sentence; it is a no-op for client alone", async () => {
    await scan("both").ready(0);
    await scan("client", "http://127.0.0.1:1").ready(0);
    assert.equal(scan("both").describe(), `client patterns + Presidio at ${url}`);
  });

  it("F2 the start-up check refuses a Presidio without the entities ChainAim needs", async () => {
    const stock = stubPresidio(REQUIRED_PRESIDIO_ENTITIES.filter((e) => e !== "IN_AADHAAR"));
    const at = await listen(stock.server);
    try {
      await assert.rejects(scan("both", at).ready(0), /does not support IN_AADHAAR/);
    } finally {
      await close(stock.server);
    }
  });

  it("F2 AskSession masks the prompt with the scan it is given and restores it on this machine", async () => {
    const s = new AskSession({ docsDir: "unused", maxSpend: "0.05", maxTokens: 256, names: true, dryRun: true, show: () => undefined, promptMask: true, promptScan: scan("both") });
    const { masked, counts } = await s.maskPrompt(PROMPT);
    assert.ok(!masked.includes("Ravi Kumar"));
    assert.equal(counts.PERSON, 1);
    assert.equal(s.restoreForDisplay(masked).text, PROMPT);
    // Presidio down: refused, and the session keeps no map for it.
    stub.state.mode = "error";
    try {
      await assert.rejects(s.maskPrompt("Ask Jane Roe"), AskRefused);
    } finally {
      stub.state.mode = "ok";
    }
  });
});
