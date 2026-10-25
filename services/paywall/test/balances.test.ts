/** scripts/balances-core.ts: address parsing and the printed line. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Wallet } from "xrpl";
import { BalancesRefused, formatLine, parseAccounts } from "../scripts/balances-core.ts";

// Sample addresses generated for each run: tests never reference a real wallet.
const B01 = Wallet.generate().classicAddress;
const SELLER = Wallet.generate().classicAddress;

describe("parseAccounts", () => {
  it("reads label=address and a bare address", () => {
    assert.deepEqual(parseAccounts([`buyer=${B01}`, SELLER]), [{ label: "buyer", address: B01 }, { label: SELLER, address: SELLER }]);
  });
  it("refuses none, and an address with a bad checksum", () => {
    assert.throws(() => parseAccounts([]), BalancesRefused);
    assert.throws(() => parseAccounts([`buyer=${B01.slice(0, -1)}${B01.endsWith("V") ? "W" : "V"}`]), /not a valid XRPL classic address/);
  });
});

describe("formatLine", () => {
  it("shows XRP in XRP (not drops) and the RLUSD balance", () => {
    assert.equal(formatLine("buyer", B01, { exists: true, drops: "87605603", rlusd: "1" }), `buyer  ${B01}  XRP 87.605603  RLUSD 1`);
  });
  it("says when there is no trust line, and when the account is not on the ledger", () => {
    assert.equal(formatLine(B01, B01, { exists: true, drops: "1000000" }), `${B01}  XRP 1  RLUSD no trust line`);
    assert.equal(formatLine("x", B01, { exists: false }), `x  ${B01}  not on the ledger`);
  });
});
