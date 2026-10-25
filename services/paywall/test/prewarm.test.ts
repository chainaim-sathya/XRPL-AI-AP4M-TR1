/**
 * P14: the pre-warmed XRP Ledger connection (scripts/xrpl.ts warmLedger), used
 * by the buyer agent's --ledger-prewarm. A stand-in client: no server, no
 * network.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { warmLedger, type LedgerClient } from "../scripts/xrpl.ts";

type Fake = LedgerClient & { connects: number; disconnects: number; requests: string[]; open: boolean };

/** Connects after `delayMs`; fails the first `failFirst` connects. */
function fakeClient(options: { delayMs?: number; failFirst?: number } = {}): Fake {
  let failures = options.failFirst ?? 0;
  const fake = {
    connects: 0,
    disconnects: 0,
    requests: [] as string[],
    open: false,
    async connect() {
      fake.connects++;
      await new Promise((r) => setTimeout(r, options.delayMs ?? 0));
      if (failures > 0) {
        failures--;
        throw new Error("connect refused");
      }
      fake.open = true;
    },
    async disconnect() {
      fake.disconnects++;
      fake.open = false;
    },
    isConnected() {
      return fake.open;
    },
    async request(r: { command: string }) {
      fake.requests.push(r.command);
      return { result: { command: r.command } };
    },
  };
  return fake as unknown as Fake;
}

describe("P14 warmLedger", () => {
  it("P14 connects at once, before any read, and every read reuses the one connection", async () => {
    const client = fakeClient({ delayMs: 20 });
    const warm = warmLedger("wss://ledger.invalid", { client });
    assert.equal(client.connects, 1, "the connection is opened when warmLedger is called");
    assert.deepEqual(await warm.ledger("server_info"), { command: "server_info" });
    await warm.ledger("account_info", { account: "rX" });
    await warm.ledger("fee");
    assert.equal(client.connects, 1, "no new connection per read");
    assert.deepEqual(client.requests, ["server_info", "account_info", "fee"]);
    await warm.close();
    assert.equal(client.disconnects, 1);
  });

  it("P14 a read made while connecting waits for the connection instead of failing", async () => {
    const client = fakeClient({ delayMs: 50 });
    const warm = warmLedger("wss://ledger.invalid", { client });
    const read = warm.ledger("server_info");
    assert.equal(client.requests.length, 0, "nothing sent before the connection is open");
    await read;
    assert.deepEqual(client.requests, ["server_info"]);
    await warm.close();
  });

  it("P14 a failed start-up connect is retried once at the first read", async () => {
    const client = fakeClient({ failFirst: 1 });
    const warm = warmLedger("wss://ledger.invalid", { client });
    await warm.settled;
    assert.deepEqual(await warm.ledger("server_info"), { command: "server_info" });
    assert.equal(client.connects, 2);
    await warm.close();
  });

  it("P14 a server that cannot be reached is reported as unreachable, and nothing is requested", async () => {
    const client = fakeClient({ failFirst: 2 });
    const warm = warmLedger("wss://ledger.invalid", { client });
    await assert.rejects(warm.ledger("server_info"), (e: Error & { code?: string }) => /cannot connect to the XRP Ledger server wss:\/\/ledger\.invalid/.test(e.message));
    assert.deepEqual(client.requests, []);
    await warm.close();
    assert.equal(client.disconnects, 0, "nothing to close");
  });
});
