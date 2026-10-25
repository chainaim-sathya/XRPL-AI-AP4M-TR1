# STATE

**Spec:** `architecture-xrpl-migration.md` (Algorand/USDC → XRPL/RLUSD)
**Updated:** 2026-10-13
**Current stage:** Stages 0, 1, 3, 4, 5 and 6 are done in code and tests. Stage 2 (accounts) and the real-payment proof in Stage 3 are the owner's. Stage 7 (MainNet) is not started.

Evidence for everything below is in `BUILD_LOG.md`. Owner steps are in `MANUAL_SETUP.md`.

## Test status

| Suite | Before | Now |
|---|---|---|
| Gateway (`npm test`, repo root) | 266 pass | 266 pass, untouched |
| Paywall (`services/paywall`) | 46 pass | 56 pass |
| Web (`services/web`) | 87 pass | 103 pass |

## Requirement status

| ARCH-ID | Status |
|---|---|
| ARCH-001 behavioural equivalence | Non-payment tests pass unchanged. Payment tests rewritten for the new rail. |
| ARCH-002 privacy pipeline untouched | No file under `services/gateway`, `services/presidio`, `packages/route-engine` or `config` was modified. |
| ARCH-003 placeholder format | Route descriptions, schemas and examples in `routes.ts` unchanged. |
| ARCH-004 dollar prices | `$0.01` becomes the RLUSD amount `"0.01"`. Three `amount / 1e6` conversions removed: `web/src/wallets.ts`, `paywall/scripts/pay.ts`, `test-console/console/server.ts`. |
| ARCH-005 isolation boundary | Tested: no payment header reaches the gateway. |
| ARCH-010, ARCH-011 configuration | Done, tested. |
| ARCH-012 address checksum | Done, tested (`ripple-address-codec`). |
| ARCH-013 invoices | Done, tested. See "Decisions" 2. |
| ARCH-014 `ReplayGuard` retired | `replay.ts` deleted after reading it in full; its guarantee is kept by `invoices.ts`. |
| ARCH-015 balance and trust line | Done, tested, and run against live TestNet. Over WebSocket, not JSON-RPC (see "Decisions" 4). |
| ARCH-016 browser signer | Done with Crossmark, tested with a stand-in. **Never run in a browser with the real extension.** |
| ARCH-017 Hono middleware | Kept `@x402/hono`, with `@x402/xrpl`'s server scheme. |
| ARCH-018 no residual references | Code, config, tests, scripts and operational docs are clear. Remaining mentions listed under "Left as they are". |

## Gaps — not proven, must be reported

1. **No real payment has settled.** The t54 facilitator was never reached from this machine (Sophos re-signs `*.t54.ai`). Everything between the paywall and the facilitator is tested only against the local test double. Unverified: that t54 accepts `@x402/core`'s verify/settle request body, and that it lists `exact` on `xrpl:1` in `/supported` (the paywall will not quote a price otherwise).
2. **Crossmark was never run.** No browser, no extension. The adapter follows `@crossmarkio/sdk@0.4.0`'s type declarations (`async.detect`, `async.signInAndWait`, `async.signAndWait` → `response.data.txBlob`, `meta.isRejected`). Whether Crossmark signs the prepared transaction without changing its `Sequence`, `Fee` or `LastLedgerSequence` is unverified.
3. **The paying scripts stop at the ledger** for want of a funded account (owner-only, spec section 11): `pay.ts`, `private-ask.ts`, `trust-line.ts`, `send-xrp.ts` were run only up to "account is not on TestNet yet".
4. Open Question 3 (TestNet facilitator URL) and Open Question 4 (Bazaar on t54) are still open. The discovery metadata is still declared, now through `@x402/extensions/bazaar`.

## Decisions taken that differ from the letter of the spec

1. **Paywall SDK.** `@x402/hono` + `@x402/xrpl` instead of a hand-written middleware on `x402-xrpl`. `x402-xrpl` is used by the scripts.
2. **Invoice is claimed at first presentation, not at settlement.** ARCH-013 says "consume it once settlement succeeds". A refused call is never settled, so that wording would let one signed payment be replayed against the free-model quota, which is the hole `ReplayGuard` closed. Claiming at verification keeps the old behaviour.
3. **`x402Fetch` is not used** in `pay.ts`: it reads the price from the 402 body, which is empty here. The SDK's `XRPLPresignedPaymentPayer` is used directly.
4. **Browser ledger reads use WebSocket**, because Ripple's public JSON-RPC servers send no CORS headers. `XRPL_RPC_URL_*` is therefore not read anywhere.
5. **`RLUSD_ISSUER_MAINNET` has no default**, following the caution in spec section 3.4.
6. **Not implemented from ARCH-011:** `XRPL_RPC_URL_*` and `XRPL_TESTNET_FAUCET_URL` (nothing reads them). `XRPL_WS_URL_*` is read by the scripts only; the web page uses the two public servers named in `web/src/balance.ts`.
7. The "pop-up" variant of the sign-timeout message is gone with Lute: Crossmark has no pop-up fallback.

## Left as they are

- `docs/superpowers/**`, `docs/blog/**`, `docs/submission.md`, `docs/demo-video-script*.md`: records of the Algorand build and challenge entry.
- `packages/route-engine/**`: protected by ARCH-002; its matches are unrelated to this rail.
- `services/web/public/wallet.js`: the word `algo` there is "algorithm" inside the Crossmark SDK.
- "Global x402 Challenge" wording in the page footer and disclaimer. The disclaimer now names "Ripple, the XRPL Foundation" where it named the Algorand Foundation; the owner should review that sentence.

## Environment notes

- `.claude/` does not exist, so no hooks ran and no snapshot was taken. Git was not used.
- `build.config.json` still describes the "shortlink" pilot; the repo has no `typecheck` script.

## Next step

Owner: `MANUAL_SETUP.md`, "Owner steps on TestNet", then one real payment with `scripts/pay.ts`, then one in the browser with Crossmark.

## 2026-10-21 — TestNet proof (owner run, repo `chainaim-router`, branch `integrate-xrpl`)

Run by the owner on the CPU-only Windows PC, steps given one at a time by Claude. Evidence is the command output quoted in that session; public addresses and hashes only, no seeds.

**Gap 1 closed: a real payment settled.**
- `node scripts/pay.ts http://127.0.0.1:8080/v1/privacy/scan --text "Patient Jane Roe, MRN 991122, was diagnosed with diabetes."` → `HTTP 200`, real Presidio scan result (dataClass PHI), `payment {"success":true,"transaction":"E55B67292C6DAFE7CC07060477FA5E65E38DCFCE8257AD8B0D5590EF8BE8400A","network":"xrpl:1",...}` with a t54 attestation extension (`environment rewards-testnet`, `nonProduction true`, `status ready`).
- `docker logs ca-paywall` → `payment_settled`, `POST /v1/privacy/scan`, amount `0.01`, asset RLUSD, `xrpl:1`, the same transaction.
- testnet.xrpl.org → Payment 0.01 RLUSD (issuer `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`) from the buyer to payTo, SourceTag `804681468`, ledger 21715209, 2026-10-21 18:26:01 UTC.
- So t54 accepts the `@x402/core` verify/settle body, and `/supported` lists `exact` on `xrpl:1`.

**Gap 4, Open Question 3 closed:** `https://xrpl-facilitator-testnet.t54.ai/supported` answered from the host and from inside `ca-paywall` with kinds `exact`, `upto`, `batch-settlement` on `xrpl:1`. The Sophos re-signing does not apply on this PC's network (it may still apply on the network where it was first seen). Open Question 4 (Bazaar listing on t54) is still not checked.

**Gap 3 closed for `new-account.ts`, `trust-line.ts`, `pay.ts`:** all ran to success on funded TestNet accounts. `send-xrp.ts` and `private-ask.ts` were not run.

**Gap 2 narrowed, not closed:** the Crossmark extension (TestNet) signed and submitted a plain 1 RLUSD Payment to the buyer. The ChainAim web page adapter (`services/web`, Connect Crossmark → Execute) has still never run in a browser.

Accounts (TestNet, public addresses):

| Role | Address | State |
|---|---|---|
| payTo (in `ca-paywall` as `XRPL_PAY_TO_TESTNET`) | `rn5hSy7QvsrQLpGb3k5dp4h8Yrk9J7gBej` | 100 XRP from faucet (tx `A37CC8A9F3F327078FAD1ADC3F316A1F7FD44988F70FD1251C7BECE4D6F80EA0`), RLUSD trust line (tx `923754D08B8D09A123F869255AEE6377A0339517373B723E09E7939A6DBB47FB`), received 0.01 RLUSD |
| Buyer for `pay.ts` | `rMosbGSCHTWnZmdgyhVETxSDRdPnormKxR` | 100 XRP from faucet (tx `025715056DA029AFC9B9169FC87884D56D4FB563CCBBB3850AFAED628FCC0EB8`), RLUSD trust line (tx `B0BA7C9E909055846FA574805E14F137D1713BCB9999C6A90E3171977D59E4B8`), got 1 RLUSD from Crossmark, paid 0.01 |
| Owner's Crossmark account | `rn4QHduCAXzkEgC1nPdUno5rWfxZarJw1a` | Holds RLUSD; sent 1 RLUSD to the buyer |
| Owner's other account | `rnfBRWuxpLnFaQUbAAjgZ1szhzRUSsPkGU` | Held 5.03 RLUSD when checked; not used |

Seeds are in the owner's password manager only.

Notes found on the way:
- The XRPL faucet web page did not fund the existing payTo address; the faucet API did: `POST https://faucet.altnet.rippletest.net/accounts` with `{"destination":"r...","userAgent":"xrpl.js"}` (host and path from `xrpl/dist/npm/Wallet/defaultFaucets.js`, body from `client/index.js` `fundWallet`).
- `new-account.ts` makes Ed25519 keys: the family seed starts `sEd` and is 31 characters.
- The scripts load the repository `.env` through `src/env.ts`; a value set in the shell wins. The services do not read `.env`.
- `ca-paywall` was recreated from image `chainaim-paywall:test` with `-e XRPL_NETWORK=testnet -e XRPL_PAY_TO_TESTNET=... -e GATEWAY_URL=http://gateway.railway.internal:8700 -e CHAINAIM_GATEWAY_KEY` on network `chainaim-test`; `RUN-ON-ANOTHER-PC.md` step 6 still shows the old Algorand `docker run` and needs this update.
- A test console process started before the merge showed the price as `1e-8` with no issuer or invoice; after restarting it the 03 Payment section shows 0.01 RLUSD, the issuer, payTo and the invoice.

Still open: the Crossmark web page payment; Open Question 4 (Bazaar); `RUN-ON-ANOTHER-PC.md` step 6 update; committing the untracked CPU config files; merging `integrate-xrpl` into `main` (nothing pushed).

## 2026-10-23 — L0 (signer-based payments + multi-tenant rig): code done, TestNet run pending

- Done (details and test output in BUILD_LOG.md, same date): `payAndFetch` pays through a signer and checks network, payment and signature before sending; `--seed-prefix` on pay.ts and private-ask.ts; `scripts/rig.ts` + `rig-core.ts` with three synthetic tenants in `rig/tenants/`; 19 new tests. Paywall 75/75 and web 105/105 on a Linux copy of 568509f.
- Next (owner): `npm install` in `services/paywall` on this PC and `npm test` there; then MANUAL_SETUP.md 2026-10-23 steps 1 to 5 for t01..t03. L0 passes at "settled 30 of 30" and 30 `payment_settled` lines from three payers.
- Next (agent, after L0 passes): L2, a KMS Ed25519 signer that implements the same `XrplSigner` in `scripts/signer.ts`.
- Open: no ARCH-ID for the rig (tests named `L0-RIG`).
- Owner run on this PC, 10:41 IST: `npm install` + `npm test` in `services/paywall`: 75/75 pass.
- Tenant wallets (TestNet, public addresses; seeds in the owner's password manager and `.env` as `XRPL_SEED_T0n_TESTNET`). Each funded with 100 XRP through the faucet API, then `trust-line.ts` opened its RLUSD line:

| Tenant | Address | RLUSD trust line tx |
|---|---|---|
| t01 | `rNyKVsrK82yU4v5WBxfAjq3Nk7Ls9oVF8U` | `9C6F39D39C642D9BA1C3097E09EF103D51691A0A96F80B548EAE3F2FAEE1FA86` |
| t02 | `rD59tmENJNnHovdi4hKq79DVP4gnDNFGWk` | `7A98E7629392B2C36109E4636DFCC6D75A3ECA5F2E8DD0F14AF5AD3F625DF3E3` |
| t03 | `rKSZJdBpp1vDpqYWbaDFKWDecwSMmmGA1B` | `2C03942CE90E6141BBDEC4812C770605A1DA92BBD744D783D5EFED6E5A5DEBEB` |

- Note for PowerShell: read a tenant seed for one command with Node's own .env parser (the same one the scripts use), never by pasting: `$env:XRPL_BUYER_SEED_TESTNET = node -e "process.loadEnvFile('../../.env'); process.stdout.write((process.env.XRPL_SEED_T01_TESTNET||'').replace(/['\x22]/g,'').trim())"`, then the script, then `Remove-Item Env:XRPL_BUYER_SEED_TESTNET`.
- RLUSD: 0.5 to each tenant from the owner's Crossmark account `rn4QHduCAXzkEgC1nPdUno5rWfxZarJw1a` (11:16–11:35 IST). Txs: t01 `3D33BDE835D9269133671D86F2F81384A7AD032184B99CDE4E4CF0BCF425C1F0`; then, in the order sent (t02, t03 assumed from that order): `A9ACA8026BAB2856F922353E3A8E120895742EFE6D7665F4F7144CC0E8581C39`, `9F0E7D0BFEF2CEE0126684F3C0ADC4699523E31CFD252F81544C5A03FC43D2EB`. Checked with `trust-line.ts` (read only): each tenant `XRP 99.999988; RLUSD trust line open, balance 0.5`.
- Rig dry run (11:37 IST): passed. Stack up (`ca-paywall`, `ca-gateway`, `ca-presidio` healthy, `ca-openrouter-stub`); price 0.01 RLUSD on xrpl:1 to `rn5hSy7QvsrQLpGb3k5dp4h8Yrk9J7gBej`.
- **BLOCKER (11:40–11:51 IST): the paywall cannot reach the t54 facilitator from this PC's current network.** Every paid call came back HTTP 402; after `payAndFetch` was taught to report the paywall's reason, it read `fetch failed`. `Invoke-RestMethod https://xrpl-facilitator-testnet.t54.ai/supported` from the host: "Could not establish trust relationship for the SSL/TLS secure channel"; the same fetch from inside `ca-paywall`: `SELF_SIGNED_CERT_IN_CHAIN`. A TLS-inspecting proxy or antivirus re-signs `*.t54.ai` (as noted for Sophos earlier). No payment was verified or settled: every tenant still holds 0.5 RLUSD. `FACILITATOR_URL_TESTNET` is unset in the container (default t54 TestNet URL). Fix is the network, not the code; TLS verification must not be switched off.
- Code change made while diagnosing: `payAndFetch` returns `refusal` (the x402 `error` in the paywall's PAYMENT-REQUIRED header); the rig records it, `pay.ts` prints it; new test. Paywall 76/76 on this PC.
- Diagnosis (11:56–11:59 IST): the re-signing CA is `Sophos / Sophos SSL CA_C44316162989-HI1GIG`; the PC was on wired Ethernet and has no Sophos services, so the interception is a Sophos Firewall on the wired LAN (inference from the CA name and the absence of local Sophos). On Wi-Fi (12:06 IST) `ca-paywall` reached t54: `/supported` lists `exact` and `upto` on `xrpl:1` (no `batch-settlement` now, unlike 21 Oct).
- **First settlements through the signer path (12:06 IST):** t01 `A5C1A5E1D2F5E0D7AC437C66D39D20A49ACB712BDC9DB21CA8E16AACA208150E`, t02 `891CE866F7250588DE80567098A5FF4FCC9E8555B3F36598EA0E12CC10F65383`, t03 `14C4C87E2B3CDBC9CD77B19AD247ECAB41C163534598DAE08F8B552713A690D7` (0.01 RLUSD each, HTTP 200). Calls 2–10 of every tenant failed before signing with "the XRP Ledger server did not answer" (no payment made): the web page's reader opened a new WebSocket per ledger read (4 per payment, 3 tenants at once), which the public TestNet server stopped answering (likely cause, inferred).
- Fix: `ledgerOverClient` / `withLedger` in `scripts/xrpl.ts` (one xrpl.js connection; server error codes kept); `payAndFetch` opens one per call by default; the rig keeps one per tenant for the whole run. 3 new tests; paywall 79/79 on the Linux copy.
- **L0 PASSED (12:11 IST, Wi-Fi):** `npm test` 79/79 on this PC; `node scripts/rig.ts --url http://127.0.0.1:8080 --calls 10` → `settled 30 of 30`, every tenant `settled 10, not settled 0, refused 0, errors 0, spent 0.1 RLUSD`. Records: `rig/out/run-2026-10-23T06-41-04-086Z.jsonl` (30 transaction hashes, one per call). First and last per tenant: t01 `FC96CC05B43CF989D18108226ACF7B4327967E8AC4757D6956BD45B49D4B399F` … `4A87CDC196D3108439A03DA76783C4475FCE4B9C73A7A79C0594F99CD16A8EC4`; t02 `F82A9B6F0C6E08C1CD24DC8A45609F8556403865AE20366AE68BBA848F582923` … `F728B1468FCB05782D9CA4ACB8F1CDADEDD77CD92DFB3412920F72A9A4F3D727`; t03 `FC8134C68E22CAD55B846CC00095B11AC50726819D77F1C3DA0C6ED535845D4C` … `3F12C7AA9D50C6A78AB7A08D555340250BE6104FBF0FA1928CD55ED5E93293E1`. Expected balances now 0.39 RLUSD per tenant (0.5 − 0.01 from the 12:06 run − 0.10). Cross-checked 12:14 IST: `docker logs ca-paywall --since 30m` shows 11 `payment_settled` lines for each of the three payers = 10 from this run + 1 from the 12:06 run; nothing else settled.
- Next (agent): L2, a KMS Ed25519 signer implementing the same `XrplSigner` (`scripts/signer.ts`). Long term (owner): ask IT to exclude `*.t54.ai` from the Sophos Firewall's HTTPS inspection, or keep running on Wi-Fi.

## 2026-10-23 — L1 (buyer agents on Strands + Bedrock): code done, PC test and Bedrock run pending

- Order changed by the owner: L1 before L2 (L2 waits on AWS KMS access).
- Done (details in BUILD_LOG.md, same date): `agent.ts` / `agent-core.ts` (one tool, `chainaim_private_ask(file, question)`), shared `private-ask-core.ts`, `private-ask.ts` thinned onto it, `test/agent.test.ts` (11 tests), tenant docs in `rig/tenants/t0n/docs/`, Strands SDK 1.20.0 + zod 4.6.7 in `package.json`. 90/90 on the Linux copy.
- Note: an earlier draft of `agent-core.ts` and `agent.ts` was already on the PC at 12:46 IST from an earlier session; it was compared byte for byte, kept (agent-core) and rewritten (agent.ts, 1 byte different).
- Next (owner): MANUAL_SETUP.md "2026-10-23 — buyer agents (L1)" steps 1 to 4. L1 passes at one answered, settled tool call from a tenant agent, with the model's inputs holding only masked text (the tests check that last part).
- Next (agent, after L1 passes): L2, KMS Ed25519 signer.
- Open: no ARCH-ID for L0 or L1.

## 2026-10-24 — M1 (mask everything that reaches a model): code done on the Linux copy, PC test and real-Presidio run pending

- Repository: `chainaim-router-private-ai-2`. Priority set by the owner: masking before any model call comes first; wallet, packages/, prechecks/, hack/ wait.
- Done (BUILD_LOG.md 2026-10-24 M1): tools/response_format/stop masked; bank account, titled name, street address, date of birth, location detected and masked; residual check refuses (422) what still looks personal; `/v1/privacy/mask` reports it. 292/292 on the Linux copy.
- Next (owner): MANUAL_SETUP.md "2026-10-24 — M1" steps 1 to 3. M1 passes when the gateway starts against the real Presidio and the spy shows no statement values.
- Risk: if the real Presidio misses an extra start-up value, the gateway refuses to start and names the type; `--extra-entities` can switch that group off while the pattern is fixed.
- Open: no ARCH-ID for M1.
- **M1 PASSED (2026-10-24 00:19 IST, Windows PC):** `npm test` 292/292; gateway rebuilt and started against the real Presidio with every extra group (start-up sentence detected); `test-console\leak-check.ps1` on the sample bank statement: HTTP 200, 1 model body and 1 Jev body left, none of the 11 identifiers in them or in the ledger.
- Uncommitted on the PC (owner commits by hand): the 18 M1 files, `test-console/leak-check.ps1`, `test-console/samples/sample-bank-statement.values.txt`, BUILD_LOG/STATE/MANUAL_SETUP entries.
- Next (choose): run leak-check on a real statement with a values file kept outside the repo; or the deferred work (wallet created once and reused; packages/, prechecks/, hack/ layout).
- 2026-10-24 01:05 IST: M1b (private chat answers keep placeholders; `KEEP_PLACEHOLDERS` in index.html, `chainaim_restore` in the gateway) and M1c (place names not masked by default; `--extra-entities all` adds them) PASSED on the PC: 296/296 tests; local CPU models (`ollama-cpu-8gb`) answered with `<PERSON_1>`/`<PERSON_2>` from the sample PDF. All still uncommitted.
- Open: the buyer agent's own Bedrock prompt is not masked (agent-core.ts header); Word/Excel uploads need the extractor service; company and neighbourhood names are not detected.

## 2026-10-24 — M1d: real statement values scrubbed (code done, PC rebuild and release pending)

- Done (BUILD_LOG.md M1d): the owner's real account number and two titled names replaced with synthetic values in 7 files (incl. the tracked DESIGN/xrplh-5 doc); 0 left in the working tree; 296/296 in the Linux shell on the PC.
- Still exposed: tag v1.0.2 (and v1.0.0/v1.0.1 if they hold them) and every commit containing those lines on `private2`. Removing them from history is destructive and the owner's decision.
- Next (owner): MANUAL_SETUP.md "2026-10-24 — M1d" steps 1 to 4 (Windows npm test, rebuild, canary, commit + tag v1.0.3 + push to private2).
- Next (agent, after that): NEXT STEP 2, the HTTP 422 `digits 1` on the owner's real statement (needs the shape only, digits written as d).
- Open: no ARCH-ID for M1d. PROJECT_CONTEXT.md still says locations are masked by default; since M1c they are not (`--extra-entities all` adds them).
- M1d PC run PASSED (2026-10-24 03:44 IST): Windows `npm test` 296/296; gateway image rebuilt; start-up test with the synthetic values passed against the real Presidio; local/qwen2.5-3b answered. Environment fixed on the way: gateway key file copied from PRIVAI1 (gitignored), `qwen2.5:1.5b-instruct` pulled, stopped containers started. Remaining: owner commit + tag v1.0.3 + push; history-rewrite decision.

## 2026-10-24 — S1: stack.ps1 written; PC run pending

- ca-paywall on this PC is the Algorand-era container (image 2026-10-17, AVM_PAY_TO/X402_NETWORK), so the console's Crossmark payment quotes 10000; do not pay until it is replaced.
- Done: `test-console/stack.ps1` (parse and guard paths checked); RUN-ON-ANOTHER-PC.md step 6 updated.
- Next (owner): MANUAL_SETUP.md "2026-10-24 — S1" steps 1-3, then the paid chat in the console with Crossmark (on Wi-Fi).
- Then: commit M1d + S1, tag v1.0.3, push to private2; history-rewrite decision.
- Open: no ARCH-ID for S1. docs/setup-end-to-end.md step 5 still says the pay-to address is "58 capital letters and digits" (Algorand wording).

## 2026-10-24 — P1/P2: paying without Crossmark

- B01 `racuvQQJSCD2YUxR5qLstLBfbCkxj53dcU`: 100 XRP, RLUSD trust line (tx A689DDB3...48F2), seed in C:\PRIV-AI-SECRETS\testnet.env (owner only). C01 `rpViNCWEsanJ2Yyu8qzPNA5Ux5Vy1j3ETG` (Crossmark, 100 XRP, no trust line): Crossmark cannot submit from this Chrome profile.
- New `buy-rlusd.ts` (11 tests pass in the Linux shell); full paywall `npm test` not yet run.
- Next (owner): MANUAL_SETUP.md "2026-10-24 — P2" steps 1, 3, 4; then the paid private chat as B01: `node scripts\private-ask.ts --file ..\..\rig\tenants\t01\docs\supplier-dispute.txt --url http://127.0.0.1:8080 --seed-prefix XRPL_SEED_B01` with the seed loaded.
- Open: no ARCH-ID for P1/P2. private-ask.ts has no --env-file (the seed is set in the window for one command).

## 2026-10-24 — R1 + E2E: done
- R1 (lenient restore, honest counts, x-chainaim-unresolved, copy-placeholders instruction) and e2e-private-ask.ts: gateway 315/315 (Linux), paywall 125/125 (Windows), gateway image rebuilt, E2E PASSED 8/8 (tx 8F76668F...CEE5).
- Next (owner): commit everything (M1d, stack.ps1, RUN-ON-ANOTHER-PC.md, buy-rlusd, balances, R1, e2e, logs), tag v1.0.3, push to private2. Answer: were the three scrubbed values real? (decides the history rewrite).
- Optional: rerun E2E with --question about the people, to see lenient restore live.
- 2026-10-24 01:43Z: R1b (gateway ignores client <C_...> in its count) and R2 (residual false positive "Dr. <placeholder>" + next line) fixed; gateway 319/319; E2E t02 (PHI) PASSED 8/8 with names restored (tx E8DC51C0...D4F4). Remaining: optional E2E t03; commit + tag v1.0.3 + push; real-values question.
- Breadcrumb: DESIGN/xrplh-6-ASK-PAYMENT-ATOMICITY-2026-10-23T2102.md, how the paid ask and its payment are tied (x402 exact: verify, serve, settle, release) and two narrow "paid, no answer" windows (W1 caller leaves during settle; W2 facilitator error after submit). Fix proposed, not started; needs an ARCH-ID.

## 2026-10-24 — L1 on Bedrock (Nemotron, Sydney): PASSED; prompt masking code done, test run pending

- **Bedrock route chosen:** AWS free-plan project (account 897258608518) is limited to **ap-southeast-2**; model **`nvidia.nemotron-nano-3-30b`** (serverless, tool calling checked via Converse, no Anthropic form). CLI profile `chainaim`; session from `aws login --profile chainaim --remote` (about 12 h; renew before demos).
- **L1 PASSED (12:41 IST):** Strands agent on Nemotron called `chainaim_private_ask`, paid 0.01 RLUSD from t02 (tx `1381D3AC072E7BAF2CE8F845F735D361CC523CA693939C5D0425D827130E8660`); ChainAim's answer came from local/qwen2.5-3b because the gateway runs mode `ollama-cpu-8gb`, whose catalog holds local models only.
- **Fixed and tested:** residual titled-name false refusal (gateway 297/297, image rebuilt); agent told ChainAim's real refusal reason (paywall 91/91).
- **Code done, not yet tested on the PC:** prompt masking (`--prompt-mask on`), document aliases (`--doc-aliases on`), `--tenant-label`, defaults ap-southeast-2 + Nemotron. Expected `npm test` in services/paywall: 93.
- **Uncommitted (owner commits last):** M1/M1b/M1c files from the night; today `services/gateway/src/privacy/residual.ts`, `services/gateway/test/residual.test.ts`, `services/paywall/scripts/{private-ask-core.ts, agent-core.ts, agent.ts}`, `services/paywall/test/agent.test.ts`, `BUILD_LOG.md`, `STATE.md`, `DESIGN/xrplh-8-STRANDS-vs-BEDROCK-DIRECT-design-2026-10-24T1130IST.md`.
- **Next (recommended, xrplh-8 §12):** Nemotron on Bedrock also as ChainAim's answering model through the gateway (Bedrock API key; rig `--openai-check`; `config/catalog.bedrock.json` with local Qwen kept as local-only/fallback; mode `bedrock.json`); PHI-to-private-cloud decision; check model invocation logging is off.
- Open: bare names in a typed prompt are not masked (client-mask names need a label); the tool's masked answer returns to Nemotron, so AWS sees ChainAim's answer (clinical content included) — a pass-through option is pending.

## 2026-10-24 13:55 IST — Nemotron in both roles: PASSED

- Prompt masking, aliases, tenant label, Sydney/Nemotron defaults: tests 93/93 and live dry run passed.
- Gateway on Bedrock: rig R5 6/6 (both OpenAI-compatible endpoints accept the key and the `provider` field); mode `bedrock` (`config/catalog.bedrock.json`, `config/scores.bedrock.json`) serves bedrock/nemotron-nano-3-30b with local Qwen as fallback. Paid agent run: tx `6044D2F4999730ECB08C4E8CBE3C8E06177A8234A825247CE15A5AD19A5F2306`, gateway served Bedrock (PHI, data_collection deny), 19.7 s end to end.
- **Secret to remove after the event:** Bedrock long-term API key created 2026-10-24 13:39 IST in ap-southeast-2, expires about 2026-10-29. Delete it in Bedrock → API keys (it also created an IAM user). It lives only in the password manager, the PowerShell session, and `ca-gateway`'s container settings while mode `bedrock` is on.
- Owner `npm test` after the alias-note fix: 98/98 (13:54 IST).
- P12 done (13:56 IST, owner screenshot of Bedrock → Settings): Model invocation logging is OFF (region-specific setting; the project is limited to ap-southeast-2). The same page says access to all serverless models is enabled by default at the account level.
- **Owner requirement (14:00 IST):** "The system must accept any type of user-provided data, detect and mask all identifiable sensitive information before sending it to an AI model, and prevent unmasked sensitive data from leaving the gateway, regardless of the data type or model provider."
- **P11 decided = A** (from that requirement; owner "ok" 14:02): masked data, PHI included, may go to any model provider, Bedrock included; masking is the control. Legal review still needed before a regulated deployment (xrplh-7 flags HIPAA/DPDP).
- **Gap analysis against the requirement (14:01):** gateway path holds (masks before every model, fails closed, residual guard). Gaps: (1) the gateway restored its own placeholders before replying (ledger `restored: true`), and the agent then passed that answer to Nemotron outside the gateway — fixed by F1 below; (2) the typed prompt reaches Bedrock with only client-mask applied (bare names not caught) — F2, mask it with Presidio on the PC; (3) only .txt/.md (agent) and PDF (console) are accepted — F3, extractor service for Word/Excel/CSV, clear refusal or OCR for images; (4) organisation names and neighbourhoods are not detected — F4, coverage + a leak test per data type.
- **F1 PASSED (14:10 IST):** `npm test` 99/99; live paid run tx `EC595FFB151DE70CFE33D51421E8972952A8BD35447025BCE70B102B1ADD8ED7`, ledger `"restored":false`, served bedrock/nemotron-nano-3-30b (PHI, deny), gateway 4.0 s. Details: `private-ask-core.ts` `serverRestore` sends `chainaim_restore: false` (chat only); `agent-core.ts` `SessionOptions.serverRestore`; `agent.ts` `--server-restore on|off` (default off); placeholder note now names both `<C_...>` and `<PERSON_1>` forms; `agent.test.ts` +1 test (expected `npm test` 99). Trade-off: values only the gateway caught show as its placeholders on the user's screen too.
- Pending: P13 pass-through option; P14 measure where the 19.7 s goes; catalog pricing placeholder; P15–P19 as listed in the 13:11 work list; then the owner's commit.

## 2026-10-24 ~15:00 IST — F2 (typed prompt masked with the tenant's Presidio): code done, owner test run pending

- **Tenant-side Presidio:** existing container `presidio` (image `chainaim-presidio`) on `127.0.0.1:5002`, separate from ChainAim's `ca-presidio` (no host port, network `chainaim-test`). Owner checks 14:39 IST: `/supportedentities` lists IN_AADHAAR, IN_PAN, PERSON; `/analyze` of "Ask Ravi Kumar about the report" → PERSON 4–14, score 0.85.
- **Design:** `--prompt-scanner both` (default) runs client-mask + local Presidio (gateway's entity set and ad-hoc recognizers), merges spans, masks `<C_TYPE_n>`, self-checks with both (spans inside placeholders ignored), then the gateway's residual check (`--prompt-residual on`). **Fail closed:** Presidio down/error/malformed → prompt refused, nothing sent to Bedrock; start-up test-sentence check → exit 2 when not ready. No silent fallback.
- **Uncommitted, add to the owner commit:** new `services/paywall/scripts/prompt-scan.ts`, `services/paywall/test/prompt-scan.test.ts`; changed `services/paywall/scripts/agent-core.ts` (`maskPrompt` now async, `SessionOptions.promptScan`), `services/paywall/scripts/agent.ts` (flags `--prompt-scanner`, `--presidio-url`, `--presidio-threshold`, `--presidio-timeout-ms`, `--presidio-wait-ms`, `--presidio-extra-entities`, `--prompt-residual`), `services/paywall/test/agent.test.ts` (await), `test-console/start.cmd` (starts `presidio`).
- **Owner `npm test` 14:59 IST: 111/111 pass** (12 new F2 tests included); gateway 297 (unchanged, not rerun).
- **Dry run 15:04 IST PASSED (masking):** start-up line `client patterns + Presidio at http://127.0.0.1:5002, residual check`; `masked 1 PERSON`; Bedrock saw `Ask <C_PERSON_1> what my note says about follow-up`. Side observation (not F2): Nemotron asked "which document" instead of calling the tool although only doc-1.txt is listed (ALIAS_NOTE says to use the single document); 0 tool calls. Possible fix later: stronger single-document instruction.
- **Fail-closed check 15:06 IST PASSED:** with `presidio` stopped, the agent printed "the prompt scanner is not ready, so nothing was sent to Bedrock or ChainAim: Presidio at http://127.0.0.1:5002 did not answer within 10000 ms (presidio /supportedentities?language=en: TypeError)", no Bedrock call, exit 2; `presidio` restarted afterwards.
- **Paid run attempt 15:07 IST:** masking passed (`masked 1 PERSON`, Bedrock saw `I am <C_PERSON_1>. ...`), but Nemotron again asked for a file name (inventing doc-2.txt) and made 0 tool calls; nothing paid.
- **Fix (15:10, code done, tests pending):** `agent-core.ts` `singleDocumentNote()` added to the instructions when exactly one document is listed; tool `file` is now optional and `AskSession.onlyDocument()` fills it when one document is listed (several: refused, "name one"). `agent.test.ts` +1 test (expected `npm test` 112).
- Owner `npm test` 15:09 IST: **112/112 pass**.
- **F2 PASSED (15:10 IST live paid run):** prompt "I am Ravi Kumar. ..." → `masked 1 PERSON`, Bedrock saw `I am <C_PERSON_1>. What does my discharge note say about follow-up?`; Nemotron called the tool (single-document fix worked): `doc-1.txt (discharge-note.txt): answered, 0.01 RLUSD, tx 9068145D36C5AE0CA84816D2888EEF65D51E47573AEB913A4CE56A1C4A1E3BE6`; 1 tool call, spent 0.01 RLUSD.
- Next: P14 (timing, `--timing` flag, target ≤10 s p95), then P13, F3, F4, pricing, P15–P18, owner commit.

## 2026-10-24 ~15:25 IST — P14 timing: code done, owner test run pending

- `agent.ts --timing off|on|json` (default off): per request, phases startup, presidio_check, prompt_mask, agent_invoke, bedrock_and_loop (= agent_invoke − tool.total), tool.total, tool.doc_mask, tool.ledger_connect, tool.quote_402, tool.ledger_network, tool.ledger_prepare, tool.sign, tool.paid_call, tool.other; plus since process start. json = one `timing {...}` line for collecting runs.
- Files: new `services/paywall/scripts/timing.ts`, `services/paywall/test/timing.test.ts`; changed `scripts/xrpl.ts` (`PayOptions.onPhase`, laps in `payAndFetch`), `scripts/private-ask-core.ts` (forwards onPhase), `scripts/agent-core.ts` (`SessionOptions.timing`), `scripts/agent.ts`, `test/agent.test.ts` (+1).
- Known limit: AWS credential lookup is inside the first Bedrock turn (bedrock_and_loop); gateway-internal split comes from the gateway ledger (latencyMs), not from this flag.
- Owner `npm test` 15:21 IST: **116/116 pass**. Timed live run not done yet (next: `--timing on` paid run, then fixes toward ≤10 s).
- **First timed paid run (15:29 IST, tx `F29554DD64ED521C291E226D3D44CC02EBAFB1D2682FEAB3A79D93012157B1AE`):** since process start 25,725 ms; startup 2,635; presidio_check 673; prompt_mask 113; agent_invoke 22,183 = bedrock_and_loop 8,377 + tool.total 13,806 (doc_mask 4, ledger_connect 1,535, quote_402 408, ledger_network 278, ledger_prepare 780, sign 27, paid_call 10,165, other 609). paid_call alone exceeds the 10 s budget; split pending (gateway ledger latencyMs vs t54 verify/settle; F1 run showed gateway 4.0 s, so ~6 s settlement is an inference, unverified). Side note: words run together in ChainAim's answer ("yourfasting", "ifyou"); origin not checked.

## 2026-10-24 ~15:45 IST — P13 (answer pass-through): code done, owner test run pending

- `agent.ts --answer-to-model none|masked` (default **none**): none = the tool returns `answer: null` + `PASS_THROUGH_NOTE`; ChainAim's answer is printed on this computer only; system prompt and tool description tell the model it gets no answer text and should reply with one short confirmation. masked = old behaviour. Start-up line states which.
- Files: `services/paywall/scripts/agent-core.ts` (`ANSWER_TO_MODEL`, `AnswerToModel`, `SessionOptions.answerToModel`, `PASS_THROUGH_NOTE`, `ToolReply.answer: string | null`, `askTool`, `systemPrompt(..., answerToModel)`, `buildAgent`), `services/paywall/scripts/agent.ts`, `services/paywall/test/agent.test.ts` (+1 test, expected `npm test` 117).
- Known limit: the agent's second Bedrock turn still runs (now a one-line reply); stopping the Strands loop right after the tool was not done because the TS SDK's API for it was not checked.
- Owner `npm test` 15:37 IST: **117/117 pass** (P13 test included).
- **Paid run 15:44 IST FAILED:** Nemotron replied "The answer is shown above." with 0 tool calls (the system-prompt line about how to reply after an answer was read as the task); nothing paid; 7.4 s total.
- **Fix (15:50, code done):** system prompt now says the tool must be called for every document question and the "shown above" reply is allowed only after a tool result with status answered; `agent.ts` guard: with `--answer-to-model none` and no tool call in a request, prints "the agent did not call ChainAim, so no answer was produced" and exits 1. Expected `npm test` still 117.
- Next: owner `npm test`, then the timed paid run again.
- Owner `npm test` 15:49 IST: **117/117 pass**.
- **P13 PASSED (15:50 IST live paid run, `--answer-to-model none --timing on`):** start-up line "answer text NOT sent to Bedrock (shown here only)"; `masked 1 PERSON`; `doc-1.txt (discharge-note.txt): answered, 0.01 RLUSD, tx C8074BA138765C9F6700EB62159D31CD7AB7DF24C06B15014758C9EB42DF18BE`; ChainAim's answer printed locally; agent reply "The answer is shown above."; 1 tool call, 0.01 RLUSD. The single-document direct-call flag (work-list item 1) is not needed.
- Timing of that run: since process start 21,468 ms; startup 1,065; presidio_check 688; prompt_mask 115; agent_invoke 19,535 = bedrock_and_loop 4,373 + tool.total 15,162 (doc_mask 2, ledger_connect 1,458, quote_402 280, ledger_network 246, ledger_prepare 780, sign 18, paid_call 11,861, other 517). bedrock_and_loop fell from 8,377 to 4,373 (the second turn is now one line); paid_call rose from 10,165 to 11,861 and is the largest phase. Its split (gateway latencyMs vs t54 verify/settle) is still unverified.
- **paid_call split (15:52 IST, gateway ledger `/data/ledger/decisions-2026-10-24.jsonl`, entry ts 2026-10-24T10:20:35.512Z, decisionId 427e1cef-1626-48e3-86ad-c1960d50a1c2):** gateway latencyMs 3,320 (Bedrock attempt 2,830; served bedrock/nemotron-nano-3-30b, PHI, deny, restored false). So of paid_call 11,861 ms, **~8,541 ms is outside the gateway**: the paywall's t54 verify + t54 settle (settle presumably waits for ledger validation) + local hops. Verify vs settle split is not measured yet (paywall logs no phase times — to check in `services/paywall/src`).
- Next (agent): read the paywall's verify/settle path in `services/paywall/src`; add a flag-controlled phase log (verify_ms, gateway_ms, settle_ms; names and numbers only) to the `payment_settled` line; then the XRPL pre-warm in agent-core/private-ask-core (`--ledger-prewarm on|off`), worth ≤ ~1.5 s (ledger_connect 1,458). Settling after replying would remove settle from the wait but changes the payment guarantee (paywall currently never serves unsettled) — owner decision, not to be done silently.

## 2026-10-24 ~16:30 IST — P14 fixes + Sydney price: code done, owner test run pending

- **1c paywall phase log:** env `PAYWALL_PHASE_LOG=on|off` (default off; `src/config.ts` `phaseLog`). `src/app.ts`: per-request marks in AsyncLocalStorage; `payment_settled` gains `phases {capacity_ms, verify_ms, gateway_ms, settle_ms}` (verify = onBeforeVerify → proxy start; gateway = proxied fetch to response headers; settle = proxy end → onAfterSettle; only the two hooks already used). `settledPhases()` exported; `PaywallDeps.clock`. New `test/paywall-phases.test.ts` (4 tests). Service change: needs `chainaim-paywall:test` rebuilt and `ca-paywall` recreated with `-e PAYWALL_PHASE_LOG=on`.
- **1a pre-warm:** `scripts/xrpl.ts` `warmLedger(wsUrl, {client?})` connects at once in the background; reads wait for it, reconnect once if lost, report "unreachable" otherwise. `scripts/agent.ts` `--ledger-prewarm on|off` (default on; off in dry runs): opened right after set-up passes (before the Presidio check and the first Bedrock turn), reused for every payment via `SessionOptions.ledger`, closed at exit; start-up line says which. With it on, `tool.ledger_connect` leaves the timing table. New `test/prewarm.test.ts` (4 tests). Expected paywall `npm test`: **125**.
- **2 price:** `config/catalog.bedrock.json` Nemotron pricing 0.0618 / 0.2472 USD per 1M in/out tokens (Standard, Asia Pacific (Sydney), aws.amazon.com/bedrock/pricing updated 2026-10-21). Free-pool filter uses OpenRouter `:free`, not pricing (`routing/freepool.ts`); catalog validation accepts any number ≥ 0 (`catalog.ts`). Route-engine use of pricing not read. Correction 16:55 (verified): not baked into the image: `test-console/modes/bedrock.json` has `mountConfig: true` and `switch-models.ps1` mounts `config\` read-only at /config, so it takes effect when `ca-gateway` is recreated with `switch-models.ps1 -To bedrock` (no rebuild); no behaviour change expected. Notes also mark the baseUrl verified (R5 6/6).
- `RUN-ON-ANOTHER-PC.md` step 6 now shows the XRPL `docker run` (closes that open item).
- Owner `npm test` 16:07 IST: **125/125 pass**. `chainaim-paywall:test` rebuilt; `ca-paywall` recreated with `-e PAYWALL_PHASE_LOG=on` (same payTo/gateway/key as 2026-10-21); `/healthz` ok.
- **P14 timed paid run 16:10 IST PASSED (pre-warm on), tx `51E00034F3171F27A61517D5644967E7C6DD14744D846E1874733930CF831423`:** since process start 25,483 ms; startup 1,179; presidio_check 693; prompt_mask 127; agent_invoke 23,334 = bedrock_and_loop 11,012 + tool.total 12,322 (doc_mask 5, quote_402 375, ledger_network 248, ledger_prepare 821, sign 20, paid_call 10,846, other 8). vs 15:50: tool.total −2,840 (ledger_connect 1,458 gone; tool.other 517 → 8, inferred: the per-payment disconnect now happens once at exit). bedrock_and_loop +6,639 (4,373 → 11,012): not explained; one run, inferred Nemotron variance and a longer reply; needs repeated `--timing json` runs.
- **paid_call split MEASURED (paywall phase log, same tx):** capacity 8, **verify 932, gateway 3,360, settle 6,514** ms; sum 10,814 vs client paid_call 10,846 (32 ms local hops). Settle (t54 submit + waiting for the XRPL result, inferred) is 60% of paid_call and the largest single phase of the request.
- **Owner decision pending (D-P14-settle):** settling after replying would save ~6.5 s but the paywall would serve before the payment is confirmed (today it never serves unsettled). Alternatives to evaluate: t54 options for a faster settle confirmation; serving with a verified-but-unsettled payment only for trusted payers. Not to be done silently.
- **Not started this session:** F4 organisation detection, P15–P18.

## 2026-10-24 ~16:45 IST — F3 (PDF, Word, Excel, CSV read before masking): code done, owner test run pending

- **Design:** documents are read on the tenant's machine, before masking, by new `services/paywall/scripts/extract.ts` (agent and private-ask only; the gateway and its no-dependency rule are untouched). PDF text layer (unpdf 1.9.1, MIT, no deps), Word .docx (mammoth 1.13.0, BSD-2), Excel .xlsx (exceljs 4.4.0, MIT), CSV (own RFC 4180 parser). Parsers load lazily (a .txt run loads none). All three are devDependencies: the paywall image (`npm ci --omit=dev`) is unchanged.
- **Refused clearly, nothing sent:** images (no OCR), PDFs with no text layer (scans), password-protected PDFs, .doc/.xls/.ppt ("save as .docx/.xlsx"), files whose first bytes do not match their extension, empty documents, files over `--max-doc-mb` (20) or over 1,000,000 characters.
- **Why tables are labelled by default (verified in `services/gateway/src/privacy/entities.ts`):** the gateway's DATE_OF_BIRTH and BANK_ACCOUNT recognizers score 0.1 and pass only with a context word ("birth", "dob", "account", "bank"...) nearby. Rows are written as one `Header: value` line per cell, and dates as YYYY-MM-DD (matches the y-m-d pattern); formulas give their saved result only, never the formula text. `--table-format grid` exists but weakens that detection. The header row is always written out too (`Columns: ...`): a key/value sheet has data in its first row (bug found and fixed while testing: an e-mail address in row 1 had disappeared).
- **Privacy fix found on the way:** a refusal named the file by its full path, and that reason went to the model, undoing `--doc-aliases`. Now the model's reason names the file as the model did (alias); this machine shows `alias (real name)`. (The old readDocument messages had the same issue.)
- **Measured in the workspace (Node 22.23, real libraries):** `test/extract.test.ts` 15/15; masking probe: client-mask masks names, labelled accounts, phones and e-mails in the extracted text; dates of birth are left for the gateway (client-mask has no DOB rule). Not run on the PC yet.
- **New flags (agent.ts and private-ask.ts):** `--doc-types all|txt,md,pdf,docx,xlsx,csv`, `--table-format labelled|grid`, `--table-header first-row|none`, `--csv-delimiter` (","; `\t`), `--max-doc-mb` (20). New timing phase `tool.doc_read` (read) beside `tool.doc_mask` (mask only).
- **Files:** new `services/paywall/scripts/extract.ts`, `test/extract.test.ts` (15), `test/fixtures/documents.ts` (builds PDF/docx/xlsx at test time, no binary fixtures), `test-console/samples/f3/clinic-patients.csv` (synthetic); changed `scripts/private-ask-core.ts` (`loadDocument`), `scripts/agent-core.ts` (`listDocuments(docsDir, types)`, `SessionOptions.extract`, `Shown.read`, alias-safe refusal reasons), `scripts/agent.ts`, `scripts/private-ask.ts`, `scripts/timing.ts`, `test/agent.test.ts` (image refusal message, P14 phase list, +2 F3 tests), `test/private-ask.test.ts` (refusal messages), `package.json` (3 devDependencies; `package-lock.json` changes when the owner runs `npm install`). Expected paywall `npm test`: **142** (125 + 15 + 2).
- **Dependency audit (npm audit, 2026-10-24):** 2 moderate, both `uuid` via exceljs ("missing buffer bounds check in v3/v5/v6 when buf is provided"); exceljs only calls `uuid` v4, when writing conditional formatting, so the advisory does not apply to reading.
- Owner `npm install` + `npm test` 16:33 IST: **142/142 pass** (F3 15 + agent 2 included). `npm install` added 204 packages.
- **Owner `npm audit` 16:35 IST: 9 (4 moderate, 5 high).** From F3: only `uuid` <11.1.1 + `exceljs` (2 moderate; not applicable, v4 only; `--force` would downgrade exceljs to 3.4.0: do not). Already present before F3, production side: `hono` 4.13.9 (serveStatic path double-decoding; app.ts does not use serveStatic; fixed in 4.13.13, package.json pins 4.13.9 exactly); `zod` <4.6.6 nested in `@x402/core` and `@x402/extensions` (GHSA-mrhx-c7xc-m3w5, memory exhaustion validating oversized constrained collections; 5 high entries via the @x402 chain; no fix available; input bounded by Node's header size limit and the 4 MiB body limit, sufficiency not proven); `fast-uri` 3.0.0–3.1.8 (4 advisories; non-breaking `npm audit fix` available; which package depends on it not identified).
- **S1 (open, separate from F3):** bump `hono` pin to 4.13.13 (paywall image rebuild + tests); check which package pulls `fast-uri` and run non-force `npm audit fix`; watch `@x402/*` for a release on zod >= 4.6.6 and decide whether to pin an override.
- **F3 dry run 16:37 IST (CSV, `--docs ..\..\test-console\samples\f3`):** Nemotron made 0 tool calls and asked which file ("confirm the file name ... e.g. doc-1.csv") although doc-1.csv was the only document; the guard reported it (exit 1, nothing paid). The single-document note names "note, report, letter, record or document"; "my patients' visit schedule" matched none (inference).
- **P15 direct single document (code done 16:45, tests pending):** `agent-core.ts` `directDocument(session, enabled)`; `agent.ts --direct-single-doc on|off` (default on). With exactly one document and `--answer-to-model none`, each request goes straight to `session.ask(onlyDocument, prompt)`: Bedrock is not called (saves its 4–11 s; the model can no longer skip the tool). The request is the tool's question, masked with the document by prepareAsk (client-mask, one placeholder map). Trade-off: in this route the typed request is masked by client-mask only (like the document text), not by the tenant's Presidio (F2), because two maps would number placeholders twice; the gateway's Presidio still masks it before any model. Several documents, `masked`, or off: the model decides as before. `agent.test.ts` +1 (P15). Expected `npm test`: **143**.
- Owner `npm test` 16:40 IST: **143/143 pass** (P15 included).
- **F3 + P15 dry run 16:42 IST PASSED:** start-up line `direct: one document (doc-1.csv) ... Bedrock is not called`; `doc-1.csv (clinic-patients.csv): dry_run`, `read on this computer: csv, 3 rows`; masked text = question + labelled rows, all 3 names, 3 account numbers, 3 phones masked; dates of birth and next-visit dates left (as predicted by the workspace probe).
- **F3 + P15 paid run 16:43 IST PASSED (payment and masking), tx `0C9AFFF8F0DDC700A75823CA5AAD8101A3A667CD69939BF9F439C0999447169F`:** since process start **13,857 ms** (16:10: 25,483); startup 1,046; presidio_check 58; agent_invoke 12,637 = bedrock_and_loop **0** + tool.total 12,637 (doc_read 1, doc_mask 2, quote_402 498, ledger_network 1,652 (the pre-warmed connection was still opening: no Bedrock turn to hide it behind), ledger_prepare 768, sign 13, paid_call 9,698, other 5). The answer was right (the two November visits, the third in December).
- **Bug found in that run, fixed 16:47 (tests pending):** the answer showed `C_PERSON_1` instead of the names: the gateway's model wrote placeholders without angle brackets (`**C_PERSON_1**`) and `client-mask.ts` `restore()` matched only `<C_...>`. Fails safe (no leak). Fix: `restore()` also accepts a bare `C_TYPE_n` standing as its own word, put back only when it is in this session's map; a bare unknown one is left and not counted; bracketed behaviour unchanged. Probed in the workspace on the existing test line, the run's text and look-alikes. `client-mask.test.ts` +1. Expected `npm test`: **144**.
- **For F4:** client-mask misses the given name in "Surname, Given" ("Kumar, Ravi" → `<C_PERSON_1>, Ravi`); the gateway's Presidio is the second line. Pre-existing, seen in the F3 probe.
- Uncommitted, add to the owner commit: `services/paywall/src/{app.ts,config.ts}`, `services/paywall/scripts/{xrpl.ts,agent.ts}`, `services/paywall/test/{paywall-phases.test.ts,prewarm.test.ts}`, `config/catalog.bedrock.json`, `RUN-ON-ANOTHER-PC.md`, `STATE.md`.

## RESUME POINT — 2026-10-24 03:30Z: v1.0.3 released (commit c96f6c0)
- Released: privacy scrub (M1d); lenient restore + honest counts + copy-placeholders instruction (R1, R1b); residual false-positive fix (R2); buyer tooling (buy-rlusd.ts, balances.ts, test-console/buyer.ps1); e2e-private-ask.ts (BEFORE / WORK / AFTER / ledger check / 10-check VERDICT); stack.ps1; DESIGN/README.md (new member) and DESIGN/xrplh-6 (ask/payment coupling).
- Wallets (TestNet, public): buyer B01 racuvQQJSCD2YUxR5qLstLBfbCkxj53dcU (~0.95 RLUSD; seed in owner's C:\PRIV-AI-SECRETS\testnet2.env as XRPL_SEED_B01_TESTNET); seller rn5hSy7QvsrQLpGb3k5dp4h8Yrk9J7gBej (~0.40 RLUSD).
- Open, in order: (1) owner: were the three scrubbed values real? repo is PUBLIC and v1.0.0-v1.0.2 hold them -> make private / rewrite history; (2) run buyer.ps1 on Windows (address, balances, e2e) and README example 4 (refund letter) after R1b; (3) client-mask: 12-digit a/c typed IN_AADHAAR, "Ridgeway" in a company name masked as PERSON; (4) xrplh-6 W1/W2 fix (needs ARCH-ID); (5) NEXT STEP 2/3 from the original handoff (real NZ statement 422 "digits 1"; titled-name over-masking, "DR" as debit, PHONE_NUMBER on amounts); (6) deferred: console "pay with local wallet" button, wallet create-once/reuse, buyer agent Bedrock prompt masking, Word/Excel extractor.
- This entry and its BUILD_LOG line are uncommitted (go in the next commit).

## RESUME POINT — 2026-10-24 05:35Z: H2 (hosted by name) + X1 (questions across CSV files) built, uncommitted
- H2: gateway zones (--auto-zones, --phi-zones, x-chainaim-zone), hosted registry entries, mode ollama-cpu-8gb-hosted, --model / -Model in scripts, console Zone cell. Gateway 327/327.
- X1: analyst /relations + /sql (relate.ts, sqlrun.ts), crossask.ts shared by console POST /crossask (new "Ask across files" block) and services/analyst/scripts/ask.ts. Analyst 32/32.
- Next (owner, Windows): delete services\analyst\node_modules (Linux bindings), then the steps in MANUAL_SETUP "2026-10-24 — H2 + X1"; commit + tag v1.0.4.

## RESUME POINT — 2026-10-24 10:30Z: H2 + X1 proven live on Windows, uncommitted
- Windows: gateway 327/327, paywall 139/139, analyst 32/32 at first run (now 37 on the Linux copy after live fixes: whole-file uniqueness, 6-decimal rounding, answer-model, step errors, placeholder check).
- H2 live: hosted/nemotron-nano-reasoning answered "Paris", x-chainaim-zone public-api; chainaim/auto stays local. switch-models.ps1 refuses a bad pasted secret (Ctrl+V at hidden prompt gave 1 control char).
- X1 live: relations (Claim # key many-to-one, Patient, Payer category); hosted model writes SQL from headers; local model words the answer (--answer-model); result computed here. Nvidia free endpoint often full (probe-openrouter-chat.ts shows "ResourceExhausted ... (882/16)" inside HTTP 200).
- Open: (a) gateway masks amounts as PHONE_NUMBER (seen "$<PHONE>.07") and payer names as PERSON - NEXT STEP 3; (b) stack.ps1 WARN Substring exception in the paywall check; (c) console "Ask across files" not yet clicked in a browser on Windows; (d) owner: delete _to_delete\ (not ignored by git), commit + tag v1.0.4; (e) earlier open items (scrubbed values / public repo, client-mask labels, xrplh-6 W1/W2).

## BACKLOG (owner-ordered)
- Postman check of the ACTUS collection (C:\PRIV-AI-DATA\smb\jupiter-loan.postman_collection.json): import, Send, expect 200 + same 8 events. Deferred by owner 2026-10-24 11:23Z.
- ACTUS Mentor --via mentor run (needs ACTUS_MENTOR_API_KEY); confirm the hosted Mentor's ACTUS_SERVER_URL.

## RESUME POINT — 2026-10-24 ~18:25Z: merging v1.0.4 into 728de99 (conflicts resolved on disk; merge commit pending)
- Next (owner): git add the 4 files, npm ci in services/paywall (v1.0.4 adds @aws-sdk/client-bedrock-runtime, exceljs, mammoth, unpdf), run the three suites, commit the merge; then run the Docker stack from ONE clone only; UI test; push; tag v1.0.5.
- Open decisions: which clone runs the stack (recommended PRIVAI2); may chainaim/auto use Bedrock (private-cloud); PHI local only or local + Bedrock; one "all models" mode (local + OpenRouter + Bedrock by name).

## RESUME POINT — 2026-10-24 ~20:40Z: v1.0.5 being cut (merge of v1.0.4 + this clone's work)
- In v1.0.5: v1.0.4 (Bedrock Strands agent, F3 document extraction, F2 prompt masking, P14 timing); hosted-by-name + zones; ALL-1 one gateway with local + OpenRouter + Bedrock (mode ollama-cpu-8gb-all); analyst cross-file questions (relations, read-only SQL, code values, no-rows retry, many-to-many join guard), ERPNext JSON, finance demo data (smb/personal), ACTUS (actus-schedule, contract-cashflows with document check + retry, direct or via ACTUS Mentor); console tab 03; start-ui.ps1; stack.ps1 PS 5.1 Substring fix; tools/evm-wallet (XRPL EVM).
- Live on Windows: all checks passed; three models answer by name; contracts -> ACTUS saved (3/3 with Bedrock + retry); overdue question correct (Northline 177,050.90; cross-checked).
- NOT built, designed: DESIGN/xrplh-9 (client-side mask + restore on every path; 3 decisions) and DESIGN/xrplh-10 (pricing fixed 0.1 + data + model estimate; 3 decisions).
- Backlog: Postman checks; npm audit warnings (paywall 9, evm-wallet 2) unreviewed; actus-schedule.ts onto src/actus.ts; over-masking (company names as PERSON, amounts as PHONE); the PRIVAI2-104 clone's local .env.example holds real secrets (local only) - move out; one clone runs the Docker stack (this one).
