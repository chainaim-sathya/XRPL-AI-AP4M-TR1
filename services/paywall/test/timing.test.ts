/**
 * P14: the timing report (scripts/timing.ts). Phases hold names and
 * milliseconds only.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatTiming, summarize, Timing } from "../scripts/timing.ts";

describe("P14 timing", () => {
  it("P14 sums phases by name and derives Bedrock-and-loop time and the tool's unlisted remainder", () => {
    const s = summarize([
      { name: "startup", ms: 1200.4 },
      { name: "agent_invoke", ms: 9000 },
      { name: "tool.total", ms: 5000 },
      { name: "tool.paid_call", ms: 3000 },
      { name: "tool.ledger_connect", ms: 700 },
      { name: "tool.sign", ms: 300.6 },
    ]);
    assert.equal(s.startup, 1200);
    assert.equal(s.bedrock_and_loop, 4000);
    assert.equal(s["tool.other"], 999);
    // Two tool calls in one request add up.
    const two = summarize([
      { name: "agent_invoke", ms: 10 },
      { name: "tool.total", ms: 3 },
      { name: "tool.total", ms: 4 },
    ]);
    assert.equal(two["tool.total"], 7);
    assert.equal(two.bedrock_and_loop, 3);
  });

  it("P14 time() records a phase even when the timed work throws", async () => {
    const t = new Timing();
    await assert.rejects(t.time("prompt_mask", () => Promise.reject(new Error("no"))));
    await t.time("agent_invoke", () => 1);
    assert.deepEqual(
      t.take().map((p) => p.name),
      ["prompt_mask", "agent_invoke"],
    );
    assert.deepEqual(t.take(), [], "take() forgets what it returned");
  });

  it("P14 the table lists known phases in pipeline order, then any others, then the process's age", () => {
    const table = formatTiming({ "tool.paid_call": 3, agent_invoke: 9, zeta: 1, startup: 2 }, 15.4);
    const names = table.split("\n").map((l) => l.trim().split(/\s+/)[0]);
    assert.deepEqual(names, ["startup", "agent_invoke", "tool.paid_call", "zeta", "since"]);
    assert.match(table, /since process start\s+15 ms$/);
  });
});
