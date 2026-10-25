# xrplh-15 — Signing today (XRPL L1) vs AP4M vouchers (XRPL EVM) for paid private inference, plus job cost estimate

Breadcrumb: xrplh-10 (pricing) → xrplh-11 (AP4M fit) → xrplh-13 (session record) → **xrplh-15** (this).
Status: DESIGN ONLY, no code changed. Written 2026-10-24 21:45 (UTC-05:00). Track: mid-check-2, Track 1 (Agentic Finance).

Tags: [CODE] read in this repo today · [SDK] DESIGN/REF/ap4m-x402.mjs, ap4m-hackathon-sdk.js, ap4m-agent.js, example-x402-*.mjs ·
[DECK] DESIGN/REF/Mastercard_AP4M_XRPL_Hackathon_Workshop.pptx (text extracted today) · [GUIDE] hackathon.ap4m.build/integration-guide ·
[AGENTS] hackathon.ap4m.build/sdk/AGENTS.md · [WEB] other page read today (named) · [ASSUME] not verified; the check is named.

Could NOT read today (client error): hackathon.ap4m.build/docs/x402.md, /llms.txt, /llms-full.txt, /docs/api-reference.md.
The x402 protocol details below therefore come from the SDK source only.

---

## 0. Bottom line

1. Today's rail: the **buyer signs a complete XRPL `Payment` transaction** (RLUSD IOU, exact amount, invoice in Memo + InvoiceID) with
   its family seed; the paywall's t54 facilitator only **submits** that signed blob, and only after the gateway answered < 400. [CODE]
2. AP4M rail: the **agent never signs a token transfer**. It signs an **EIP-712 Voucher `{channelId, cumulativeAmount}`** (no gas).
   The **merchant** sends `redeemVoucher` (merchant pays gas). The **AP4M service** later moves RLUSD from the PooledEscrowVault to the
   merchant payout address (`settle`). [SDK, DECK slide 6]
3. To sell *inference* (not a static file) on AP4M, ChainAim needs **its own merchant** built from the `@ap4m/sdk` primitives, because
   the kit's `createX402Merchant` serves one fixed JSON `content` at `GET /resource` with no request body. [SDK]
4. Variable price is not supported by the AP4M x402 path (`pricingMode` must be `fixed`). Design: **quote per job, then put that quote
   in the challenge as its fixed amount**. Whether the service accepts a different amount per challenge is [ASSUME] — check first.
5. Cost estimate: exact pre-count of **input** tokens exists for some Bedrock models (CountTokens, free, matches billing). **Output**
   length has no production pre-estimate API, so the quote uses the `max_tokens` cap as the upper bound. Formula in §6.

---

## 1. Design recap (from mid-check-1 / xrplh-11 / xrplh-13)

- Keep Strands TS 1.20.0 + BedrockModel (Nemotron) + tool `chainaim_private_ask`; masking on the tenant PC; Bedrock sees placeholders.
- Swap only the rail under the tool: `--rail xrpl-t54|ap4m` (default xrpl-t54 so nothing breaks).
- Leg A (tenant agent → ChainAim merchant) real; Leg B (ChainAim → model provider) stays API-key/USD, shown as cost pass-through.
- Three fences: on-chain Channel cap (AP4M), session ceiling `--max-spend` (code exists), data fence (masking).
- Verified on chain earlier: agent wallet 0x139E…bf30 (98.83 XRP gas, 0.02 RLUSD); contracts from /public/config:
  RLUSD 0x27b5…16f3, PaymentLedger 0xcAB4…aE91, ParticipantRegistry 0x4cF2…D1E8, PooledEscrowVault 0x83DD…aBC0; chain 1449000.
- Open owner question carried over: fixed price 0.10 or 0.01 RLUSD.

---

## 2. How RLUSD moves buyer → seller today (XRPL L1, x402 "exact", t54)  [CODE]

| # | Where | What happens |
|---|---|---|
| 1 | `scripts/xrpl.ts` `account()` | Seed read from env `XRPL_BUYER_SEED_TESTNET` (prefix configurable per tenant); `Wallet.fromSeed`. Seed never printed. |
| 2 | `scripts/signer.ts` `seedSigner()` | Wraps the wallet as `XrplSigner { classicAddress, sign(tx) }` → `wallet.sign(tx).tx_blob`. Seam for KMS/hardware signers. |
| 3 | `agent-core.ts` `AskSession.askNow` → `private-ask-core.ts` `sendAsk` | Calls `payAndFetch` with `maxAmount = remaining()` (session ceiling − spent). |
| 4 | `xrpl.ts` `payAndFetch` | First POST → 402 with `PAYMENT-REQUIRED`; picks `scheme=exact` on the buyer's network; refuses a price above `maxAmount` before signing. |
| 5 | `xrpl.ts` `checkNetwork` | `server_info.network_id` must equal the CAIP-2 network (xrpl:1 Testnet). |
| 6 | `web/src/xrpl-payment.ts` `preparePayment` | Builds `Payment`: `Amount = SendMax = {currency RLUSD, issuer, value=price}` (never partial), `Destination = payTo`, `Memos[invoiceId]`, `InvoiceID = sha256(invoiceId)`, `Sequence`, `Fee` (≤ 10,000 drops), `LastLedgerSequence = validated + ceil(maxTimeout/5) + 2`. |
| 7 | signer | Buyer signs the whole transaction (secp256k1/ed25519 per seed). |
| 8 | `xrpl.ts` `checkSigned` | Decodes blob; every prepared field must be unchanged; `Account` = buyer; `verifySignature` true. Else nothing is sent. |
| 9 | `xrpl-payment.ts` `paymentHeader` | `PAYMENT-SIGNATURE` = base64 canonical JSON `{x402Version:2, accepted:offer, payload:{signedTxBlob, invoiceId}, resource}`. |
| 10 | `paywall/src/app.ts` | `onBeforeVerify`: invoice claimed once (replay guard). Facilitator (`HTTPFacilitatorClient`, default `https://xrpl-facilitator-testnet.t54.ai`) verifies; handler proxies to gateway (payment headers stripped). |
| 11 | x402 middleware | Settles only if the gateway answered < 400: facilitator **submits the buyer-signed blob** to XRPL → RLUSD moves buyer trust line → `XRPL_PAY_TO_TESTNET`. `onAfterSettle` logs `payment_settled` with tx hash. |
| 12 | client | `PAYMENT-RESPONSE` decoded → tx hash; `spent += amount` only when `receipt.success`. |

Key property: the facilitator cannot change amount or destination (signature covers them); the payment is atomic with the answer
(no answer → never submitted). Who can move funds: only the buyer key.

---

## 3. AP4M on XRPL EVM: who signs what  [SDK, DECK, GUIDE]

| Signature / tx | Signed by | Gas | Function |
|---|---|---|---|
| Sign-in (EIP-191 `signMessage` on a service challenge) | Agent (or funding) wallet | no | `signIn` → Bearer token |
| Channel request (vault tx from `/channel-requests/prepare`) | Agent wallet | **yes** | `requestChannel`; service binds merchant payout, PaymentLedger checks registry at `openChannel()` |
| **Voucher** EIP-712: domain `{name:"AP4M Payment Ledger", version:"1", chainId, verifyingContract: PaymentLedger}`, type `Voucher{bytes32 channelId, uint256 cumulativeAmount}` | Agent wallet | no | `signVoucher`; inside x402 `buildX402PaymentPayload` (payload carries `voucher` + `agentSignature`) |
| `redeemVoucher(voucher, agentSignature)` tx | **Merchant submitter** (x402 path) or agent (direct demo path) | yes | Verifies signature, advances `redeemed` watermark, **no token transfer**, emits `VoucherRedeemed` |
| `settle` / `recordSettlement` + payout | AP4M service keys (operator/PSP — never ours [AGENTS]) | — | Sends `redeemed − settled` RLUSD from vault to payout; `ClaimPaid` + `SettlementRecorded`; receipt URL |
| Close checkpoint (EIP-712 typed data from service) | Agent wallet | no | `closeChannel` |

Rule enforced on chain: `settled ≤ redeemed ≤ cap` [DECK 6, 12]. Vouchers are **cumulative** (running total) [AGENTS].
Difference from L1: payment is a *signed promise against escrow*, settlement is deferred and done by the platform.

Registry ("AgentPrincipal registered with Mastercard"): done in the participant portal via PSP-sponsored onboarding, not in code
[AGENTS: "Team onboarding … happens in the participant portal, not in code"]. Our code relies on it indirectly: the merchant checks
`binding.channel.merchantId/payout` and the agent checks `channel.agent === wallet.address`, `status === 1` [SDK].

---

## 4. What it takes to sell inference over AP4M (gap analysis)

| # | Gap (fact) | Design |
|---|---|---|
| G1 | `createX402Merchant` serves a single static `content` (≤ 64 KiB), identity pins one `amount` per state dir [SDK] | Build `ap4m-merchant` in the paywall using the same primitives it imports: `buildMerchantResourceChallenge`, `buildX402Challenge`, `prepareX402Redemption`, `verifyX402Payment`, `verifyMerchantResourceRedemption`, `buildX402RedemptionResponse`, `readPaymentChannelBinding`. Keep its SQLite idempotency pattern (challenges / payments / resource_results). [ASSUME] exact primitive signatures — read `@ap4m/sdk` after install. |
| G2 | x402 hot path is `GET /resource` with only `X-AP4M-CHANNEL-ID` / `PAYMENT-SIGNATURE` headers; no body [SDK `request()`] | Two-step job: (a) free `POST /v1/ap4m/jobs` with the **masked** request → `{jobId, quote}`; (b) `buyResource(..., requestFetch)` where the injected fetch adds `X-ChainAim-Job: <jobId>` (`requestFetch` is an official parameter). Merchant binds jobId into the challenge record. [ASSUME] whether the resource URL itself may carry the job id — `parseX402ResourceUrl` rules unread. |
| G3 | `pricingMode` must be `fixed`; agent rejects otherwise [SDK] | Per-job fixed quote: challenge `amount` = estimate (§6) converted to wei. Agent's `maximumAmount` = min(session remaining, `--max-price-rlusd`); SDK also enforces `amount + redeemed ≤ cap`. Fallback if per-challenge amounts are refused: tiered fixed resources (S/M/L by max_tokens), one merchant state dir each. |
| G4 | Order in kit merchant: redeem on chain, then release [SDK] | Custom order: verify voucher (`prepareX402Redemption`) → **run inference** → submit `redeemVoucher` → verify receipt → release answer. Inference failure → no redemption → agent not charged (same "never settle on failure" property as today's L1 rail). Must finish inside the challenge window (≤ 300 s after the challenge block, minus `--merchant-cutoff-seconds`) [SDK]. |
| G5 | Agent client limits: response ≤ 128 KiB, 150 s timeout [SDK `request()`] | Cap `max_tokens`; return masked answer only (restore on PC as today). |
| G6 | One pending payment per channel; `buyResource` one purchase per state dir at a time [SDK, AGENTS] | Tool calls already sequential (`toolExecutor: "sequential"`, AskSession queue) [CODE]. `operation` = ChainAim ask id. |
| G7 | Merchant redeems from its own wallet (gas) [SDK] | ChainAim EVM submitter key via env `MERCHANT_SUBMITTER_KEY`; payout ≠ agent ≠ funding wallet [GUIDE]. |
| G8 | Proof for judges: `VoucherRedeemed`, settlement, merchant balance change [GUIDE, DECK 16] | After each buy: `record-redemption` then `settle` (returns `receipt_url`); decision ledger gets `agent, channelId, claimId, txHash`. |

Leg B unchanged: the gateway calls Bedrock/OpenRouter with **masked** data under its own API keys; the AP4M payment pays ChainAim.

---

## 5. End-to-end flow (AP4M rail, one private ask)

```
Tenant PC (Strands agent, Bedrock sees placeholders)        ChainAim paywall/merchant + gateway          XRPL EVM 1449000 / AP4M service
1  user question → agent decides to call chainaim_private_ask
2  tool masks document+question locally (existing)
3  tool estimates cost locally (§6) → refuse early if > remaining
4  POST /v1/ap4m/jobs {masked request} ───────────────▶ store job, recount placeholders, quote (§6) ◀── (free)
   ◀──────────── {jobId, quoteWei, breakdown}
5  buyResource(GET /resource, X-AP4M-CHANNEL-ID, X-ChainAim-Job)
                                             ─────────▶ readPaymentChannelBinding (open? our merchantId/payout?)
                                                        challenge(amount = quoteWei, validBefore ≤ +300 s) ──▶ 402 PAYMENT-REQUIRED
6  SDK checks: scheme batch-settlement, fixed, payTo = channel.payout,
   amount ≤ maximumAmount, amount+redeemed ≤ cap, window → signs EIP-712 Voucher (no gas), persists purchase.json
7  GET /resource + PAYMENT-SIGNATURE ─────────────────▶ prepareX402Redemption (verify) → run gateway inference
                                                        (masked → Bedrock/OpenRouter) → sendTransaction(redeemVoucher) ──▶ VoucherRedeemed
                                                        verifyMerchantResourceRedemption ◀─────────────────────────
   ◀──────────── 200 {resource: masked answer} + PAYMENT-RESPONSE (tx)
8  SDK verifies receipt, calldata, claimId, VoucherRedeemed event, finality
9  record-redemption + settle (or automatic) ─────────────────────────────────────────────▶ vault → ChainAim payout (RLUSD)
10 tool restores answer on PC; spent/remaining from chain (cap − redeemed) and session ceiling
```
Over-cap demo: set a small Channel cap; the next quote fails the SDK check `amount + redeemed ≤ cap` before signing.

---

## 6. Estimating the job cost

### 6.1 What exists (researched today)
- **Input tokens, exact, before inference:** Amazon Bedrock `CountTokens` — free, count "will match the token count that would be
  charged", model-specific, takes the InvokeModel body or Converse `{messages, system}`; returns input tokens only; not every model
  (some Claude CRIS-only models need `count_tokens` on bedrock-mantle). [WEB docs.aws.amazon.com/bedrock/latest/userguide/count-tokens.html]
  [ASSUME] Nemotron on Bedrock supports it — check the model card, else fall back to 6.2.
- **OpenRouter:** cost computed from the provider's reported tokens after the request; per-million prompt/completion rates published;
  no documented pre-request count. [WEB openrouter.ai/docs/faq]
- **Output tokens:** no production API predicts them. Research shows length is linearly decodable from hidden states of open 7–8B models,
  which hosted APIs don't expose. [WEB arxiv.org/abs/2607.05316] → use the `max_tokens` cap: quote is an upper bound, never exceeded.
- "Complexity" therefore enters only through: route/model chosen (price per token), reasoning models (extra billed tokens), and the cap.

### 6.2 Formula (one pure function, extends xrplh-10 `estimatePrice`)
```
inTok  = countTokens(maskedRequest)                         if --token-count bedrock and the model supports it
       = ceil(utf8Bytes(maskedRequest incl. system+tools) / charsPerToken × (1 + inputMargin))   otherwise
outTok = max_tokens requested (cap)
modelUsd = (inTok × inPerM + outTok × outPerM × (1 + reasoningFactor)) / 1e6
dataUsd  = perMaskedField × maskedFields + perKBSent × KB + perActusCall × actusCalls
total    = clamp(roundUp(fixed + dataUsd + costShare × modelUsd, 1e-6), minimum, maximumPerCall)   (above max → refused)
quoteWei = ethers.parseUnits(total, 18)        // AP4M RLUSD has 18 decimals [AGENTS]
```
Example (Nemotron Bedrock rates from xrplh-10: 0.0618 / 0.2472 USD per 1M; 2,000 in, 1,024 out cap, costShare 1, fixed 0.10):
model = 0.0001236 + 0.0002531 = 0.0003767 USD → total 0.100377 RLUSD.
Server recount: the gateway recounts placeholders/bytes/max_tokens of the staged job; client and server must agree within inputMargin.

### 6.3 Flags (defaults)
`--rail xrpl-t54|ap4m` (xrpl-t54) · `--ap4m-api-url` (https://hackathon.ap4m.build) · `--channel-id` / `--channel-cap` (5) ·
`--ap4m-state-dir` (./agent-state) · `--max-price-rlusd` (0.50) · `--pricing-config` (config/pricing.json) ·
`--token-count bedrock|chars` (chars) · `--chars-per-token` (4) · `--input-margin` (0.15) · `--reasoning-factor` (0) ·
merchant: `--merchant-cutoff-seconds` (30, allowed 5–299) · `--inference-timeout-ms` (90000, must fit the window).

---

## 7. AI vs manual

AI can do: build `estimatePrice` + tests; `PaymentRail` seam; `ap4m-channel` rail around `buyResource` with injected `requestFetch`;
custom merchant on SDK primitives; job staging route; ledger fields; rig scenario incl. over-cap.
Manual — owner: install `@ap4m/sdk` tgz (needs the service URL reachable from your PC); create ChainAim merchant submitter + payout
wallets and register payout in the portal; faucet XRP to submitter; paste x402.md / api-reference.md / llms.txt into DESIGN/REF.

## 8. Open checks before building
1. x402.md: does the service accept a different `amount` per challenge on the same merchant? (G3)
2. `parseX402ResourceUrl`: may the URL carry a job path? (G2)
3. `@ap4m/sdk` primitive signatures (G1).
4. Bedrock CountTokens support for the Nemotron model id in use.
5. Price: 0.10 vs 0.01 RLUSD fixed component.
