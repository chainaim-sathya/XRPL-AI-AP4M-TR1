/**
 * The fields besides the messages that reach a model (tools,
 * response_format, stop) are masked like the messages, over real sockets
 * with the stub Presidio and the stub OpenRouter. Before this, shapeBody
 * copied them from the request unscanned.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { startStubOpenRouter, type StubOpenRouter } from "../../../scripts/stub-openrouter.ts";
import { startStubPresidio, type StubPresidio } from "../../../scripts/stub-presidio.ts";
import { validateChat } from "../src/chat.ts";
import { leaked, ledgerText, post, startTestGateway, type TestGateway } from "./helpers.ts";

let presidio: StubPresidio;
let or: StubOpenRouter;
let g: TestGateway;
before(async () => {
  presidio = await startStubPresidio();
  or = await startStubOpenRouter();
  g = await startTestGateway({ presidioUrl: presidio.url, openRouterUrl: or.url });
});
after(async () => {
  await g.close();
  await presidio.close();
  await or.close();
});
beforeEach(() => {
  or.chatBodies.length = 0;
  or.decisionBodies.length = 0;
});

const chat = (body: unknown) => post(`${g.url}/v1/chat/completions`, body);
const ask = { messages: [{ role: "user", content: "Look this up, please." }] };

/** A tool whose description, parameter description, enum and property key all carry synthetic identifiers. */
const leakyTool = {
  type: "function",
  function: {
    name: "lookup",
    description: "Find records for Jane Roe (jane.roe@example.com).",
    parameters: {
      type: "object",
      properties: {
        "Priya Sharma": { type: "string", description: "Phone +1 415 555 0132" },
        account: { type: "string", enum: ["DE89370400440532013000", "plain"] },
        ssn: { type: "string", default: "078-05-1120" },
      },
      required: ["Priya Sharma"],
    },
  },
};

describe("tools, response_format and stop reach the model masked", () => {
  it("masks every description, enum, default and property key in tools, and keeps the tool name", async () => {
    const r = await chat({ ...ask, tools: [leakyTool] });
    assert.equal(r.status, 200);
    assert.equal(or.chatBodies.length, 1);
    const sent = or.chatBodies[0];
    assert.deepEqual(leaked(JSON.stringify(sent)), [], "no identifier reached the model");
    const fn = (sent.tools as { function: { name: string; description: string; parameters: { properties: Record<string, unknown>; required: string[] } } }[])[0].function;
    assert.equal(fn.name, "lookup");
    assert.match(fn.description, /<PERSON_\d+>.*<EMAIL_ADDRESS_\d+>/);
    assert.ok("<PERSON_2>" in fn.parameters.properties, "the identifier used as a key is masked");
    assert.deepEqual(fn.parameters.required, ["<PERSON_2>"], "a value masks to the same placeholder wherever it appears");
  });

  it("masks a json_schema response_format: descriptions, enums and keys", async () => {
    const response_format = {
      type: "json_schema",
      json_schema: { name: "summary", schema: { type: "object", description: "About Arjun Mehta", properties: { email: { type: "string", enum: ["jane.roe@example.com"] } } } },
    };
    const r = await chat({ ...ask, response_format });
    assert.equal(r.status, 200);
    const sent = or.chatBodies[0];
    assert.deepEqual(leaked(JSON.stringify(sent)), []);
    assert.equal((sent.response_format as { json_schema: { name: string } }).json_schema.name, "summary");
  });

  it("masks stop sequences, as a string or a list", async () => {
    for (const stop of ["Tom Baker", ["Tom Baker", "END"]]) {
      or.chatBodies.length = 0;
      const r = await chat({ ...ask, stop });
      assert.equal(r.status, 200);
      assert.deepEqual(leaked(JSON.stringify(or.chatBodies[0])), [], JSON.stringify(stop));
    }
  });

  it("classifies on what the tools hold: a medical record number in a tool makes the request PHI", async () => {
    const tool = { type: "function", function: { name: "chart", description: "Open MRN 991122" } };
    const r = await chat({ ...ask, tools: [tool] });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-chainaim-data-class"), "PHI");
    assert.deepEqual(or.chatBodies[0].provider, { data_collection: "deny" });
    assert.equal(or.decisionBodies.length, 0, "Jev never sees PHI");
  });

  it("Jev never sees an identifier from the tools", async () => {
    const r = await chat({ ...ask, tools: [leakyTool] });
    assert.equal(r.status, 200);
    assert.deepEqual(leaked(JSON.stringify(or.decisionBodies)), []);
  });
});

describe("names that must reach the model exactly as written", () => {
  it("refuses a tool name that holds personal data, and sends nothing", async () => {
    const tool = { type: "function", function: { name: "mail_jane.roe@example.com" } };
    const r = await chat({ ...ask, tools: [tool] });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error.message, /rename it/);
    assert.equal(or.chatBodies.length, 0);
  });

  it("refuses a json_schema name that holds personal data", async () => {
    const r = await chat({ ...ask, response_format: { type: "json_schema", json_schema: { name: "Jane Roe", schema: { type: "object" } } } });
    assert.equal(r.status, 400);
    assert.equal(or.chatBodies.length, 0);
  });

  it("refuses a tool_choice that names a tool the request does not have", () => {
    assert.throws(() => validateChat({ ...ask, tools: [leakyTool], tool_choice: { type: "function", function: { name: "Jane Roe" } } }, 1024), /tool_choice/);
    assert.doesNotThrow(() => validateChat({ ...ask, tools: [leakyTool], tool_choice: { type: "function", function: { name: "lookup" } } }, 1024));
    assert.doesNotThrow(() => validateChat({ ...ask, tools: [leakyTool], tool_choice: "auto" }, 1024));
  });
});

describe("the residual check, end to end", () => {
  it("refuses with 422 when masked text still holds an account number detection missed; nothing is sent; the ledger holds no value", async () => {
    const r = await chat({ messages: [{ role: "user", content: "Why was acct 991200345678 charged twice?" }] });
    assert.equal(r.status, 422);
    const msg = (await r.json()).error.message as string;
    assert.match(msg, /digits 1/);
    assert.ok(!msg.includes("991200345678"), "the refusal names kinds, never values");
    assert.equal(or.chatBodies.length, 0, "no model was called");
    assert.equal(or.decisionBodies.length, 0, "Jev was not called");
    const ledger = ledgerText(g.ledgerDir);
    assert.ok(!ledger.includes("991200345678"));
    assert.match(ledger, /"residual":\[\{"kind":"digits","count":1\}\]/);
  });

  it("checks the tools as well as the messages", async () => {
    const r = await chat({ ...ask, tools: [{ type: "function", function: { name: "f", description: "Statement for MR SAMPLEPERSON" } }] });
    assert.equal(r.status, 422);
    assert.equal(or.chatBodies.length, 0);
  });

  it("lets ordinary amounts, dates and short references through", async () => {
    const r = await chat({ messages: [{ role: "user", content: "On 2024-01-05 12:30 I paid 1,250.00 (ref 7781, total 1234567.89) on 05/01/2024." }] });
    assert.equal(r.status, 200);
  });

  it("can be switched off (--residual-guard off)", async () => {
    const off = await startTestGateway({ presidioUrl: presidio.url, openRouterUrl: or.url, residual: { enabled: false, checks: [], minDigits: 9 } });
    try {
      const r = await post(`${off.url}/v1/chat/completions`, { messages: [{ role: "user", content: "acct 991200345678" }] });
      assert.equal(r.status, 200);
    } finally {
      await off.close();
    }
  });

  it("/v1/privacy/mask reports what the check would refuse, as kinds and counts", async () => {
    const r = await post(`${g.url}/v1/privacy/mask`, { text: "Jane Roe, acct 991200345678" });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j.residual, [{ kind: "digits", count: 1 }]);
    assert.ok(!j.maskedText.includes("Jane Roe"));
  });
});

describe("chainaim_restore: the caller may keep the placeholders in the answer", () => {
  const statement = "Statement for Jane Roe, jane.roe@example.com.";

  it("restores by default, and says so in x-chainaim-restored", async () => {
    const r = await chat({ messages: [{ role: "user", content: statement }] });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-chainaim-restored"), "yes");
    assert.equal((await r.json()).choices[0].message.content, `echo: ${statement}`);
  });

  it("chainaim_restore: false returns the answer with the placeholders the model saw, and never sends the option upstream", async () => {
    const r = await chat({ messages: [{ role: "user", content: statement }], chainaim_restore: false });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-chainaim-restored"), "no");
    const content = (await r.json()).choices[0].message.content as string;
    assert.equal(content, "echo: Statement for <PERSON_1>, <EMAIL_ADDRESS_1>.");
    assert.deepEqual(leaked(content), []);
    assert.ok(!("chainaim_restore" in or.chatBodies[0]), "a ChainAim option never reaches the model");
    assert.match(ledgerText(g.ledgerDir), /"restored":false/);
  });

  it("refuses a chainaim_restore that is not true or false", () => {
    assert.throws(() => validateChat({ ...ask, chainaim_restore: "no" }, 1024), /chainaim_restore: true or false/);
  });
});
