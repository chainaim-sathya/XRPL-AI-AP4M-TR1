import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { BUNDLE, sourceHash } from "../scripts/build-wallet.ts";

describe("public/wallet.js", () => {
  it("was built from the current source (run npm run build:wallet if this fails)", () => {
    const head = readFileSync(BUNDLE, "utf8").slice(0, 200);
    assert.match(head, new RegExp(`source sha256 ${sourceHash()}`));
  });

  it("exports exactly what the page imports", () => {
    const js = readFileSync(BUNDLE, "utf8");
    const start = js.lastIndexOf("export{");
    assert.ok(start >= 0, "no export clause");
    const clause = js.slice(start + "export{".length, js.indexOf("}", start));
    const names = clause.split(",").map((entry) => entry.trim().split(" as ").pop()!).sort();
    // payAndChat is for the test console (test-console/console), which loads this bundle too.
    assert.deepEqual(names, ["balance", "connect", "disconnect", "payAndAsk", "payAndChat", "savedAccount"]);
  });

  // The unit tests pass a fake Crossmark, so only the built bundle shows how the real SDK is reached.
  // In this "type": "module" package esbuild gives a default import of the SDK's UMD build the whole
  // exports object, so `.default.async` is undefined in the browser ("reading 'detect'").
  it("reaches the Crossmark Sdk through modules.xmark, not the default import", () => {
    const js = readFileSync(BUNDLE, "utf8");
    assert.doesNotMatch(js, /\.default\.async\./, "the bundle calls Crossmark through the default import");
    // The minifier may keep modules.xmark in a variable, so the binding and the calls are checked separately.
    assert.match(js, /\.modules\.xmark\b/, "the bundle does not take the Sdk from modules.xmark");
    for (const call of ["detect", "signInAndWait", "signAndWait"]) {
      assert.match(js, new RegExp(`\\.async\\.${call}\\(`), `the bundle does not call Crossmark's ${call}`);
    }
  });
});
