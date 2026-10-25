import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LedgerError, NETWORKS, readBalance, type LedgerRequest } from "../src/balance.ts";

const RLUSD = { currency: "524C555344000000000000000000000000000000", issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" };

describe("NETWORKS", () => {
  it("ARCH-015 names the CAIP-2 ids and the public XRP Ledger servers", () => {
    assert.deepEqual(NETWORKS, {
      testnet: { caip2: "xrpl:1", wsUrl: "wss://s.altnet.rippletest.net:51233/" },
      mainnet: { caip2: "xrpl:0", wsUrl: "wss://s1.ripple.com:51233/" },
    });
  });
});

describe("readBalance (ARCH-015)", () => {
  /** An XRP Ledger server that answers account_info and account_lines with what it is given. */
  function node(info: Record<string, unknown> | Error, lines: unknown[] = []) {
    const seen: [string, Record<string, unknown> | undefined][] = [];
    const request: LedgerRequest = async (command, params) => {
      seen.push([command, params]);
      if (command === "account_info") {
        if (info instanceof Error) throw info;
        return info;
      }
      return { account: "rADDR", lines };
    };
    return { request, seen };
  }

  it("ARCH-015 reads XRP and the RLUSD held", async () => {
    const n = node({ account_data: { Balance: "3999000" } }, [{ account: RLUSD.issuer, currency: RLUSD.currency, balance: "2.5", limit: "1000000" }]);
    assert.deepEqual(await readBalance("rADDR", "testnet", RLUSD, n.request), { xrp: 3.999, rlusd: 2.5, trustLineOpen: true });
    assert.deepEqual(n.seen, [
      ["account_info", { account: "rADDR", ledger_index: "validated" }],
      ["account_lines", { account: "rADDR", peer: RLUSD.issuer, ledger_index: "validated" }],
    ]);
  });

  it("ARCH-015 reports an open trust line that holds nothing yet", async () => {
    const n = node({ account_data: { Balance: "4000000" } }, [{ account: RLUSD.issuer, currency: RLUSD.currency, balance: "0", limit: "1000000" }]);
    assert.deepEqual(await readBalance("rADDR", "testnet", RLUSD, n.request), { xrp: 4, rlusd: 0, trustLineOpen: true });
  });

  it("ARCH-015 reports an account with no RLUSD trust line", async () => {
    const other = { account: RLUSD.issuer, currency: "USD", balance: "9", limit: "10" };
    assert.deepEqual(await readBalance("rADDR", "testnet", RLUSD, node({ account_data: { Balance: "4000000" } }, [other]).request), { xrp: 4, rlusd: 0, trustLineOpen: false });
    assert.deepEqual(await readBalance("rADDR", "testnet", RLUSD, node({ account_data: { Balance: "4000000" } }).request), { xrp: 4, rlusd: 0, trustLineOpen: false });
  });

  it("ARCH-015 reports an address that was never funded as holding nothing", async () => {
    const n = node(new LedgerError("actNotFound", "the XRP Ledger server answered Account not found."));
    assert.deepEqual(await readBalance("rADDR", "testnet", RLUSD, n.request), { xrp: 0, rlusd: 0, trustLineOpen: false });
    assert.equal(n.seen.length, 1, "no trust lines are asked for");
  });

  it("ARCH-015 fails clearly when the server errors or answers in another shape", async () => {
    await assert.rejects(readBalance("rADDR", "testnet", RLUSD, node(new LedgerError("unreachable", "the XRP Ledger server did not answer")).request), /did not answer/);
    await assert.rejects(readBalance("rADDR", "testnet", RLUSD, node({}).request), /not in the expected shape/);
  });
});
