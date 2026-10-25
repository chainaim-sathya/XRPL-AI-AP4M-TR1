# xrplh-18 — AP4M paid private inference on the XRPL EVM sidechain: consolidated build design

Breadcrumb: xrplh-11 (fit) → xrplh-15 (signing + estimate) → xrplh-16 (structure) → xrplh-17 (session) → **xrplh-18** (this).
Status: **DESIGN, ready to build.** Consolidates xrplh-11/15/16 and closes their blocking check #1.
Written 2026-10-25. Codebase: `XRPL-AI-AP4M-TR1`.

Target: **XRPL EVM sidechain (Testnet 1449000), AP4M rail** — confirmed by the owner 2026-10-25. That is what makes the
**Mastercard Agentic Finance track** a live candidate for this build: AP4M is Mastercard's agent-payment kit, and the
EVM sidechain is the only chain its contracts live on. An XRPL L1 design would not qualify for that track.

Tags: [SDKSRC] read line-by-line this session from `DESIGN/REF/ap4m-x402.mjs` · [KIT] `DESIGN/REF/ap4m-*.js|mjs` ·
[DOC16] xrplh-16 · [DOC15] xrplh-15 · [GUIDE]/[DECK] as cited in xrplh-11/15 · [MEASURED] run on this PC 2026-10-25 ·
[ASSUME] still unverified, the check is named.

---

## 0. What changed since xrplh-16

Three things, all from reading the x402 SDK source rather than its header comments.

**0.1 — Blocking check #1 is CLOSED: per-job quotes are legal. Build pricing option C.**
xrplh-15 §4 G3 and xrplh-16 §9 both treated "may each challenge carry a different amount for one merchant?" as blocking,
and planned a tiered fallback. It is not blocking. The agent's entire price validation is [SDKSRC `buyResource`]:

```
accepted.extra.pricingMode !== 'fixed'                              -> reject
BigInt(accepted.amount) > BigInt(maximumAmount)                     -> reject
BigInt(accepted.amount) + BigInt(channel.redeemed) > BigInt(cap)    -> reject
```

Nothing binds `amount` to a merchant-registered or previously-seen price. `pricingMode: 'fixed'` means *this challenge names one
exact amount* — as opposed to a metered or variable-at-settlement scheme — not *this merchant has one eternal price*. The
"one price per state dir" property of the kit merchant comes from its own `config.amount`, validated once at construction
[SDKSRC `createX402Merchant`]: configuration, not protocol. **A custom merchant may quote per job.** The tiered-resource
fallback (xrplh-15 §4 G3, xrplh-16 §6 option B) can be dropped from the plan.

**0.2 — NEW constraint: the challenge must echo the channel's redeemed watermark.**
The agent also asserts `accepted.extra.acceptedCumulativeAmount === channel.redeemed`, where `channel` is read by the *agent*
at its own finalized block [SDKSRC]. Consequences:

- The merchant must read the live channel when it builds a challenge and stamp the current `redeemed` into it.
- A challenge goes stale the instant any redemption lands on that channel. The kit merchant handles this by caching one
  challenge per `channel_id` and rebuilding it when `challenge.value.previousCumulativeAmount !== channel.redeemed` [SDKSRC].
  **Ours must keep that behaviour.**
- Purchases on one channel are therefore strictly serial. That is already true of our agent (`toolExecutor: "sequential"`,
  one `AskSession` queue) but it is now a protocol requirement, not a convenience.

**0.3 — NEW constraint: `operation` pins the ceiling, not just the job.**
`buyResource` builds `intent = { environment, agent, resourceUrl, channelId, maximumAmount, operation }`, persists it, and on
resume throws `operation name belongs to another purchase` if the recomputed intent differs [SDKSRC]. `maximumAmount` is inside
that intent. So if we recompute `maximumAmount = min(ceiling − spent, maxPrice, cap − redeemed)` on each attempt, **any retry
after a partial spend changes the intent and the resume fails permanently.** Design rule: compute `maximumAmount` once when the
job is created, store it on the job, and pass the stored value on every retry of that `operation`.

**0.4 — NEW constraint: the job id reaches the merchant through `requestFetch`, not a header argument.**
[SDKSRC `vendor/ap4m-x402.mjs:97,132`] `buyResource` takes no header parameter and sends exactly one header of its own,
`{'X-AP4M-CHANNEL-ID': channelId}`. It also refuses a `resourceUrl` with a query string or fragment, and separately checks
`required.resource.url !== resourceUrl`, so the job id can go neither in the path nor the query. It does, however, accept
`requestFetch = fetch`. Design rule: the agent passes a `requestFetch` wrapper that adds `X-CHAINAIM-JOB`, and the merchant's
challenge sets `resource.uri` to the exact `resourceUrl` the agent was given. This is the seam the agent rail (step 5) is built
on; without it a per-job merchant cannot be addressed by `buyResource` at all.

**Verified live 2026-10-25** against `hackathon.ap4m.build` with the merchant of §8 running: a staged job quoted
0.103593 RLUSD and `GET /resource` returned HTTP 402 whose `PAYMENT-REQUIRED` carried `amount` `103593000000000000`,
`pricingMode` `fixed`, and `extra.acceptedCumulativeAmount` `240000000000000000` — the open Channel's live `redeemed`.
That is §0.1 and §0.2 confirmed on the chain rather than from the type declarations.

**0.5 — BLOCKER on Windows: the kit's `buyResource` cannot complete. We use the SDK primitives instead.**
[MEASURED 2026-10-25] `vendor/ap4m-x402.mjs:60-62` ends its atomic save with the POSIX durability idiom of flushing the
containing directory: `renameSync(tmp, file)` then `openSync(dirname(file), 'r')` + `fsyncSync(directory)`. Windows raises
`EPERM` both for flushing a directory handle and for flushing a read-only handle, so **every `save()` throws after already
having done its work**, and the purchase aborts between signing the Voucher and sending it. It cannot be shimmed from our
side: the helper binds `fsyncSync` through an ESM named import, which a monkey-patch of `node:fs` does not reach (measured —
the stack goes straight to `node:fs:1284`). Editing `vendor/` is worse, since it is the organizers' published kit with
checksums in `vendor/SOURCES.md`. Design rule: the agent buys through `src/agent/purchase.ts`, which rebuilds `buyResource`
on the same `@ap4m/sdk` primitives in the same order with **every** one of its checks, exactly as `src/merchant` already does
on the other side, and keeps durability by flushing the *file* handle before the rename. Note for anyone demoing on Linux or
macOS: the kit helper is fine there; this only matters on Windows.

**0.6 — The merchant must wait for finality, or the first ask on a quiet chain always 503s.**
[MEASURED 2026-10-25] The redemption is sent, mined a block or so later, and then verified against the *finalized* head,
which lags well behind. The first live paid ask redeemed successfully in block 9229036 and still answered
`503 payment_pending_or_unavailable`, because the finalized head did not cover that block until roughly 28 blocks later — a
paid, successful purchase presented to the agent as a failure needing a manual resume. The kit merchant has the same race.
Design rule: after `sendTransaction`, await the receipt, and wrap both the `VoucherRedeemed` log reconciliation and
`verifyMerchantResourceRedemption` in a bounded re-read (`finalityWaitMs`, default 90 s, counted inside the 300-second x402
window alongside the inference timeout and the cutoff margin). With this in place the second live ask completed in **15
seconds, one pass, no retry**.

**Live paid asks, verified end to end 2026-10-25** — Channel `0x6d824358…320b`, `redeemed` 0.34 → 0.546173 RLUSD:

| # | operation | quoted | tx | claim |
|---|---|---|---|---|
| 1 | `live-paid-ask-001` | 0.103593 | `0x62af43e1…8547` (block 9229036) | `0x44ceece2…a5b1` |
| 2 | `live-paid-ask-002` | 0.10258 | `0xc5ab4e6b…01f9` (block 9229084) | `0xa8e2d8a4…8213` |

Both carried a `VoucherRedeemed` event for their own claim, the payout wallet went 0.37 → 0.576173 RLUSD (exactly the two
quotes), and the two prices differ because the work differs — which is the point of §0.1.

---

## 1. Decisions locked

| # | Decision | Why |
|---|---|---|
| D1 | Chain: XRPL EVM sidechain Testnet 1449000, RPC from `GET /public/config` | owner 2026-10-25; prerequisite for the Mastercard track |
| D2 | Buyer EVM wallet = Agent Principal = Agent wallet | allowed [GUIDE]; one wallet to fund and register |
| D3 | Seller: our own Merchant ID + payout wallet via the portal, not a pool merchant | xrplh-16 R3 |
| D4 | Custom merchant on `@ap4m/sdk` primitives; inference between verify and redeem | the kit merchant serves static JSON only |
| D5 | **Pricing = option C, per-job quote** | §0.1 closes the blocker |
| D6 | All new code in `hack/ap4m/`; reaches `services/*` by HTTP only | xrplh-16 §3 |
| D7 | `PAYMENT_RAIL=ap4m` default in TR1; L1/t54 code stays dormant, not deleted | xrplh-17 turn 3 |
| D8 | Masking stays on the tenant PC; Bedrock and providers see placeholders only | unchanged product property |

Still open, non-blocking: fixed-component price (0.10 vs 0.01 RLUSD), and whether organizers require all running code public.

---

## 2. Roles and keys

| AP4M role | Who | Key / wallet | Gas? |
|---|---|---|---|
| Agent Principal (funds, authorises) | Tenant org | Buyer EVM wallet | yes, once, to open the Channel |
| Agent (decides, signs Vouchers) | Tenant's Strands agent on the PC | same wallet, `AGENT_PRIVATE_KEY` | no — Voucher signing is gasless |
| Merchant (issues 402, redeems) | `hack/ap4m` merchant | `MERCHANT_SUBMITTER_KEY` | yes, per redeem |
| Payout address | ChainAim seller wallet | `MERCHANT_PAYOUT`, key offline | — |
| Registry, PaymentLedger, Vault, settlement | AP4M service | service keys — **never ours** | — |
| Inference | `services/gateway` (unchanged) | existing gateway bearer | — |

Hard rule [GUIDE]: payout ≠ agent ≠ funding wallet. Registration is portal-only; no code of ours writes to the registry.

---

## 3. Boundary

```
hack/ap4m --import--> hack/ap4m/vendor (official AP4M files, unmodified) + npm deps
hack/ap4m --HTTP----> services/gateway          (masked inference)
hack/ap4m --HTTP----> services/client-privacy   (NEW, 127.0.0.1 only: /extract /mask /restore /scan)
hack/ap4m --HTTP----> AP4M service + XRPL EVM RPC
services/* --never--> hack/*
```

`services/client-privacy` exists only so the boundary holds: today's PC-side masking lives in
`services/paywall/scripts/{client-mask,prompt-scan,extract}.ts` and imports `services/gateway/src/privacy/*`, which `hack/`
may not do. A loopback HTTP wrapper keeps that code unchanged and the data on the PC. Enforced by
`hack/ap4m/scripts/check-boundaries.mjs` in `npm test`.

---

## 4. The flow, one private ask

```
TENANT PC                                   CHAINAIM merchant (hack/ap4m)            XRPL EVM / AP4M
1  user asks the Strands agent (Bedrock; prompt masked via client-privacy)
2  agent calls tool chainaim_private_ask(file, question)
3  client-privacy /extract + /mask       -> masked request; restore map never leaves the PC
4  estimate.ts locally -> stop now if quote > min(ceiling-spent, maxPrice, cap-redeemed)
5  POST /jobs {masked request, declared work}  --> recount placeholders/bytes/max_tokens, quote,
   <-- {jobId, quoteWei, breakdown, expiresAt}     freeze maximumAmount with the job (0.3), store, no payment
6  buyResource(resourceUrl, channelId, maximumAmount=job.maximumAmount,
               operation=jobId, requestFetch adds X-ChainAim-Job)
      GET /resource + X-AP4M-CHANNEL-ID  --> binding open? our merchantId+payout? job valid & unpaid?
                                             read channel -> stamp acceptedCumulativeAmount = redeemed (0.2)
                                             validBefore = min(channel.validBefore, ctx.validBefore,
                                                               chainTimestamp+300)
                                             past cutoff -> 503 chain_head_stale (agent retries same operation)
                                         <-- 402 PAYMENT-REQUIRED (amount = job.quoteWei)
7  SDK validates (full list in 5) -> signs EIP-712 Voucher {channelId, cumulativeAmount} -> purchase.json
8  GET /resource + PAYMENT-SIGNATURE     --> prepareX402Redemption (verify only, no chain write)
                                             POST gateway /v1/chat/completions (masked) -- Bedrock / OpenRouter
                                             inference failed -> 502, NOT redeemed, agent not charged
                                             still inside window? else 409 merchant_acceptance_closed
                                             sendTransaction(redeemVoucher) --------------> VoucherRedeemed
                                             verifyMerchantResourceRedemption <------------
   <-- 200 {resource: masked answer, breakdown} + PAYMENT-RESPONSE(tx)
9  SDK verifies receipt, calldata, claim, event, finality (see 5)
10 client-privacy /restore -> answer on the PC
11 ops: record-redemption + settle  -------------------------------------> vault -> payout RLUSD, receipt_url
12 ledger line: {jobId, agent, channelId, claimId, redeemTx, settleTx, quote breakdown, model, dataClass} - no text
```

Terminology, kept precise [DECK 6]: **redemption** advances the claim watermark and moves no tokens; **settlement** moves
RLUSD from the PooledEscrowVault to the payout address. Judges check that the payout balance changed, so both are shown.

---

## 5. What the agent SDK verifies for us (do not reimplement)

All [SDKSRC `buyResource`]. Listed because each line is both a demo talking point and a thing our merchant must satisfy.

On the 402: exactly one `accepts` entry · `resource.url === resourceUrl` · `scheme === 'batch-settlement'` · network and asset
match the loaded context · `payTo === channel.payout` · `extra.ledger` matches · `extra.bindingVersion === '1'` ·
`extra.pricingMode === 'fixed'` · `extra.channelId === channelId` · `extra.acceptedCumulativeAmount === channel.redeemed` ·
`channel.agent === wallet.address` · `channel.status === 1` · `safe.timestamp >= channel.validAfter` ·
`safe.timestamp < channel.validBefore − 5` · `amount <= maximumAmount` · `amount + redeemed <= cap` · the finalized block is canonical.

After release: the PAYMENT-RESPONSE transaction is fetched and its receipt must be status 1, at or below the finalized block, in
a canonical block; `transaction.to` and `transaction.data` must equal `encodePaymentVoucherRedemption(...)` exactly with
`value === 0`; the on-chain claim must match `channelId` and `amount`; and exactly one `VoucherRedeemed` log must match both the
`claimId` and the voucher digest.

So a dishonest merchant cannot overcharge, redirect, double-redeem, or hand back an unredeemed answer. **Our merchant's job is to
be honest and inside the window** — the proofs are the SDK's.

---

## 6. Merchant internals

Reuses the same primitives the kit imports [SDKSRC]: `readPaymentChannelBinding`, `buildMerchantResourceChallenge`,
`buildX402Challenge`, `encodeX402PaymentRequired`, `prepareX402Redemption`, `verifyX402Payment`, `derivePaymentClaimId`,
`hashPaymentVoucher`, `readPublicLogs`, `verifyMerchantResourceRedemption`, `buildX402RedemptionResponse`.
Adds: job staging, per-job amount, inference between verify and redeem, stored result per voucher.
[ASSUME] exact signatures — copy them from the kit's call sites, then confirm against the installed `@ap4m/sdk`.

SQLite, mirroring the kit's tables: `jobs`, `challenges` (one row per `channel_id`), `payments` (keyed by `voucher_digest`),
`results`. Replay of an identical `PAYMENT-SIGNATURE` returns the stored answer and never redeems twice.

Status codes to implement, taken from the kit's behaviour so the agent's retry logic works unchanged:

| Code | Body `error` | When |
|---|---|---|
| 402 | `payment_required` | challenge issued |
| 503 | `chain_head_stale` + `Retry-After: 15` | chain head too old to fit a 300 s window |
| 503 | `merchant_capacity_reached` | >1024 challenges or >10000 payments |
| 409 | `retry_retained_payment` | an incomplete payment exists on this channel |
| 409 | `merchant_acceptance_closed` | past `validBefore − cutoffMargin` |
| 409 | `request_challenge_first` | PAYMENT-SIGNATURE with no issued challenge |
| 409 | `payment_conflict` | a different voucher while one is open on the channel |
| 400 | `fixed_pricing_required` | `pricingMode !== 'fixed'` or the voucher lacks `cumulativeAmount` |
| 400 | `invalid_payment` | undecodable header, or `prepareX402Redemption` threw |
| 502 | `inference_failed` | the gateway did not answer < 400 → **nothing redeemed** |

Timing: `--merchant-cutoff-seconds` (default 30, range 5–299) and `--inference-timeout-ms` (default 90000) must satisfy
`inferenceTimeout + redeemTime < 300 s − cutoff`. 90 s plus a 30 s cutoff inside a 300 s window leaves roughly 180 s of headroom.

---

## 7. Pricing (option C)

One pure `estimate.ts`, identical on both sides; the merchant recounts and the agent refuses a quote that disagrees beyond
`inputMargin`.

```
inTok    = countTokens(maskedRequest)                      --token-count bedrock, when the model supports it
         = ceil(utf8Bytes / charsPerToken * (1 + inputMargin))   otherwise
outTok   = max_tokens                                      a cap, so the quote is an upper bound
modelUsd = (inTok*inPerM + outTok*outPerM*(1 + reasoningFactor)) / 1e6
dataUsd  = perMaskedField*fields + perKB*KB
total    = clamp(roundUp(fixed + dataUsd + costShare*modelUsd, 1e-6), minimum, maximumPerCall)
quoteWei = ethers.parseUnits(total, 18)                    RLUSD has 18 decimals
```

Vouchers only count up, so there is no refund path: overpayment against actual tokens is not returned. Keep `costShare` and the
cap small, and show "quoted vs actual" in the receipt. The job stores `quoteWei` **and** the frozen `maximumAmount` (§0.3).

---

## 8. Failure matrix

| Failure | Charged? | Recovery |
|---|---|---|
| Quote exceeds remaining | no | agent reports and stops — this is the over-cap demo |
| Merchant 503 `chain_head_stale` | no | retry the same `operation` after `Retry-After` |
| Voucher signed, agent crashes before release | **maybe** | resume the same `operation`; `purchase.json` replays the identical header |
| Inference fails after verify | no | no `redeemVoucher` is sent; retry the same `operation` |
| Redeem would be mined after the window | — | refused before submitting (409) rather than redeeming late |
| Agent retries with a changed ceiling | n/a | throws `operation name belongs to another purchase` → pass the stored `maximumAmount` (§0.3) |
| Duplicate `PAYMENT-SIGNATURE` | once | merchant returns the stored result from `payments` |

"No answer → no charge" is preserved, exactly as the L1 rail preserves it today.

---

## 9. Build order

Each step ends green; tag after each.

1. `vendor/` + `SOURCES.md` (URL, date, sha256) + `config/pricing.json` + `estimate.ts` + unit tests.
2. `services/client-privacy` (loopback wrapper) + tests.
3. `ops/setup-channel.ts`, `ops/status.ts` — read-only against the live service first.
4. Merchant against a stub gateway (tests), then against the real gateway.
5. Agent rail + tool → one live paid ask.
6. `settle` / `receipt` / ledger fields.
7. Demo scripts including over-cap.
8. `check-boundaries.mjs` wired into `npm test`.

Project tree as xrplh-16 §8, with option B's tiered-merchant variant removed (§0.1).

---

## 10. Demo, 3 minutes

1. `status` — agent registered, Channel open, cap 1 RLUSD, redeemed 0, payout balance X.
2. Ask 1 (PHI document): masked preview on the PC → quote → 402 → Voucher → answer restored locally → `VoucherRedeemed` link.
3. Ask 2: second voucher, cumulative total rises.
4. Over-cap: the quote exceeds `cap − redeemed`; the agent refuses **before signing** and says so. No human in the loop.
5. `settle` → `ClaimPaid` + `SettlementRecorded`, `receipt_url`, payout balance X + total.
6. Ledger view: lines joining agent ↔ channel ↔ claim ↔ model, with no personal data.

Rehearsal note: step 4 is the item judges explicitly look for [DECK 16], and it is the cheapest to demo because nothing is paid.

---

## 11. Precedent from the L1 rail [MEASURED 2026-10-25]

The same shape already runs end to end on XRPL L1, which de-risks every non-AP4M part of this design. Measured on this PC today:
a Strands tenant agent (t02) masked a 3-row clinic CSV locally, paid the paywall 0.01 RLUSD and got its answer —
tx `3EB3039DA34FD3202D61E46156FAF2EA261AB8BCF8F54CE11D81F1AF013C574D`, buyer 0.3 → 0.29 RLUSD, seller 0.5 → 0.51,
one `payment_settled` line on `POST /v1/chat/completions`. What AP4M replaces is only steps 4–8 of §4: the rail. Masking,
routing, the session ceiling, restore-on-PC and the ledger are already proven.

One behaviour to carry into the demo script: entities masked **server-side** by Presidio (dates of birth, under
`--extra-entities`) come back as `<DATE_OF_BIRTH_n>` placeholders, because they were never in the PC's restore map. Only
client-masked values restore. Say so on stage rather than being asked.

---

## 12. Remaining checks

| # | Check | Blocks | How |
|---|---|---|---|
| 1 | `@ap4m/sdk` primitive signatures | merchant build | install the tgz, read the package |
| 2 | Portal gives our own `MERCHANT_ID` + payout while cross-team payments are off | D3 | portal "My setup → Merchant" |
| 3 | Bedrock `CountTokens` supports the Nemotron model id | exact counts only; `chars` fallback exists | model card |
| 4 | Agent-side response ≤128 KiB / 150 s limits | the `max_tokens` cap | stated in xrplh-15 §4 G5; confirm in `request()` |
| 5 | Organizers' rule on publishing all running code | submission layout | ask the organizers |
| 6 | Fixed component 0.10 vs 0.01 RLUSD | pricing config only | owner |

Check #1 of xrplh-16/17 (variable per-challenge amount) is closed — see §0.1.
