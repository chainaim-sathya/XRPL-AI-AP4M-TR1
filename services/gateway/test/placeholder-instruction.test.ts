/**
 * R1 over real sockets (stub Presidio, stub OpenRouter): the copy-placeholders instruction
 * reaches the model only when the masked request holds placeholders and the option is on,
 * and the answer reports what it could not restore in x-chainaim-unresolved.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { startStubOpenRouter, type StubOpenRouter } from "../../../scripts/stub-openrouter.ts";
import { startStubPresidio, type StubPresidio } from "../../../scripts/stub-presidio.ts";
import { PLACEHOLDER_INSTRUCTION } from "../src/privacy/restore.ts";
import { post, startTestGateway, type TestGateway } from "./helpers.ts";

let presidio: StubPresidio;
let or: StubOpenRouter;
let on: TestGateway;
let off: TestGateway;
before(async () => {
  presidio = await startStubPresidio();
  or = await startStubOpenRouter();
  on = await startTestGateway({ presidioUrl: presidio.url, openRouterUrl: or.url });
  off = await startTestGateway({ presidioUrl: presidio.url, openRouterUrl: or.url, chatExtra: { placeholderInstruction: false, restoreLenient: false } });
});
after(async () => {
  await on.close();
  await off.close();
  await presidio.close();
  await or.close();
});
beforeEach(() => {
  or.chatBodies.length = 0;
});

const firstMessage = () => (or.chatBodies[0] as { messages: { role: string; content: string }[] }).messages[0];

describe("placeholder instruction", () => {
  it("is the first message the model gets when the masked text holds a placeholder", async () => {
    const r = await post(`${on.url}/v1/chat/completions`, { messages: [{ role: "user", content: "Write to Jane Roe about the order." }] });
    assert.equal(r.status, 200);
    assert.deepEqual(firstMessage(), { role: "system", content: PLACEHOLDER_INSTRUCTION });
  });

  it("is not added when nothing was masked", async () => {
    const r = await post(`${on.url}/v1/chat/completions`, { messages: [{ role: "user", content: "What is the capital of India?" }] });
    assert.equal(r.status, 200);
    assert.notEqual(firstMessage().content, PLACEHOLDER_INSTRUCTION);
  });

  it("is added for client placeholders too (text masked before it reached ChainAim)", async () => {
    await post(`${on.url}/v1/chat/completions`, { messages: [{ role: "user", content: "Explain <C_PERSON_1>'s note." }] });
    assert.equal(firstMessage().content, PLACEHOLDER_INSTRUCTION);
  });

  it("is not added when --placeholder-instruction is off", async () => {
    await post(`${off.url}/v1/chat/completions`, { messages: [{ role: "user", content: "Write to Jane Roe about the order." }] });
    assert.notEqual(firstMessage().content, PLACEHOLDER_INSTRUCTION);
  });
});

describe("x-chainaim-unresolved", () => {
  it("is 0 when every placeholder came back", async () => {
    const r = await post(`${on.url}/v1/chat/completions`, { messages: [{ role: "user", content: "Write to Jane Roe." }] });
    assert.equal(r.headers.get("x-chainaim-unresolved"), "0");
  });
  it("counts a lookalike of a masked type that is not in the map (the stub echoes it back)", async () => {
    const r = await post(`${on.url}/v1/chat/completions`, { messages: [{ role: "user", content: "Write to Jane Roe and PERSON_7." }] });
    assert.equal(r.headers.get("x-chainaim-unresolved"), "1");
  });
});
