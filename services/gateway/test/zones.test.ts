/**
 * Zones (H2): a hosted model (zone public-api, e.g. a free OpenRouter Nemotron) can sit in the catalog next to local
 * models. --auto-zones limits what chainaim/auto may pick; --phi-zones limits where health data may go. Both default
 * to every zone, so a gateway started without them behaves exactly as before. The served zone is reported.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { startStubPresidio, type StubPresidio } from "../../../scripts/stub-presidio.ts";
import { validateCatalog, type Catalog } from "../src/catalog.ts";
import { parseFlags } from "../src/main.ts";
import { closeServer, listen, post, startTestGateway } from "./helpers.ts";

type Upstream = { server: Server; url: string; calls: { model: string; auth: string | undefined }[] };

async function upstream(name: string): Promise<Upstream> {
  const calls: Upstream["calls"] = [];
  const server = createServer(async (req, res) => {
    if (req.url === "/health") return void res.writeHead(200).end("{}");
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    calls.push({ model: body.model, auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content: `hi from ${name}` } }] }));
  });
  return { server, url: await listen(server), calls };
}

const caps = { contextWindow: 8192, maxOutputTokens: 2048, supportsTools: true, supportsVision: false };
const chains = (order: string[]) => ({ SIMPLE: order, MEDIUM: order, COMPLEX: order, REASONING: order });

function mixed(localUrl: string, hostedUrl: string): Catalog {
  const ids = ["local/small", "hosted/nemo"];
  return validateCatalog({
    version: "test-zones",
    models: [
      { id: "local/small", zone: "local", capabilities: caps, pricing: { inputPerM: 0, outputPerM: 0 }, deployments: [{ id: "small@0", adapter: "openai", baseUrl: `${localUrl}/v1`, servedModel: "small" }] },
      // The hosted entry reads its key from an environment variable NAME (OR_TEST_KEY is set in the test pool).
      { id: "hosted/nemo", zone: "public-api", capabilities: caps, pricing: { inputPerM: 0, outputPerM: 0 }, deployments: [{ id: "nemo@or", adapter: "openai", baseUrl: `${hostedUrl}/v1`, servedModel: "nvidia/nemo:free", apiKeyEnv: "OR_TEST_KEY", probe: false }] },
    ],
    profiles: { auto: chains(ids), eco: chains(ids), premium: chains(ids) },
  });
}

describe("zones: hosted next to local", () => {
  let presidio: StubPresidio;
  let local: Upstream;
  let hosted: Upstream;
  before(async () => {
    presidio = await startStubPresidio();
    local = await upstream("local");
    hosted = await upstream("hosted");
  });
  after(async () => {
    await Promise.all([closeServer(local.server), closeServer(hosted.server)]);
    await presidio.close();
  });
  const chat = (url: string, content: string, model?: string) => post(`${url}/v1/chat/completions`, { ...(model ? { model } : {}), messages: [{ role: "user", content }] });

  it("serves a pinned hosted model with its key, and reports zone public-api; a local model reports zone local", async () => {
    const g = await startTestGateway({ presidioUrl: presidio.url, catalog: mixed(local.url, hosted.url) });
    const before = hosted.calls.length;
    const r = await chat(g.url, "What is 2+2?", "hosted/nemo");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-chainaim-model"), "hosted/nemo");
    assert.equal(r.headers.get("x-chainaim-zone"), "public-api");
    assert.equal(hosted.calls.length, before + 1);
    assert.deepEqual(hosted.calls.at(-1), { model: "nvidia/nemo:free", auth: "Bearer sk-or-test" });
    const l = await chat(g.url, "What is 2+2?", "local/small");
    assert.equal(l.headers.get("x-chainaim-zone"), "local");
    assert.equal(local.calls.at(-1)!.auth, undefined, "a local deployment without apiKeyEnv sends no key");
    await g.close();
  });

  it("without the zone options, chainaim/auto may rank any zone (unchanged behaviour)", async () => {
    const g = await startTestGateway({ presidioUrl: presidio.url, catalog: mixed(local.url, hosted.url) });
    const r = await chat(g.url, "What is 2+2?");
    assert.equal(r.status, 200);
    assert.ok(["local/small", "hosted/nemo"].includes(r.headers.get("x-chainaim-model")!));
    await g.close();
  });

  it("--auto-zones local: chainaim/auto never picks the hosted model; naming it still works", async () => {
    const g = await startTestGateway({ presidioUrl: presidio.url, catalog: mixed(local.url, hosted.url), chatExtra: { autoZones: ["local"] } });
    const before = hosted.calls.length;
    for (let i = 0; i < 3; i++) {
      const r = await chat(g.url, `Explain step ${i} of long division in detail.`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("x-chainaim-model"), "local/small");
    }
    assert.equal(hosted.calls.length, before, "auto never reached the hosted model");
    const pinned = await chat(g.url, "What is 2+2?", "hosted/nemo");
    assert.equal(pinned.status, 200);
    assert.equal(pinned.headers.get("x-chainaim-zone"), "public-api");
    await g.close();
  });

  it("--phi-zones local: health data is refused for a hosted model (400, nothing sent) and auto stays local", async () => {
    const g = await startTestGateway({ presidioUrl: presidio.url, catalog: mixed(local.url, hosted.url), chatExtra: { phiZones: ["local"] } });
    const before = hosted.calls.length;
    const phi = "Patient Jane Roe, MRN 991122, was diagnosed with diabetes. What does this mean?";
    const r = await chat(g.url, phi, "hosted/nemo");
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(await r.json()), /zone public-api.*health data/);
    const auto = await chat(g.url, phi);
    assert.equal(auto.status, 200);
    assert.equal(auto.headers.get("x-chainaim-zone"), "local");
    assert.equal(hosted.calls.length, before, "no health data reached the hosted model");
    await g.close();
  });
});

describe("zone flags", () => {
  const base = ["--model-source", "catalog"];
  it("default to every zone", () => {
    const f = parseFlags(base);
    assert.equal(f.autoZones, undefined);
    assert.equal(f.phiZones, undefined);
  });
  it("read a comma list of known zones and refuse an unknown one", () => {
    const f = parseFlags([...base, "--auto-zones", "local", "--phi-zones", "local,private-cloud"]);
    assert.deepEqual(f.autoZones, ["local"]);
    assert.deepEqual(f.phiZones, ["local", "private-cloud"]);
    assert.throws(() => parseFlags([...base, "--auto-zones", "moon"]), /--auto-zones/);
    assert.deepEqual(parseFlags([...base, "--auto-zones", "all"]).autoZones, undefined);
  });
});
