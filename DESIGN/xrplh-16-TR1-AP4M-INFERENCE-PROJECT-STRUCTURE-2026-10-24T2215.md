# xrplh-16 — TR1: AP4M (Mastercard) paid private inference on XRPL EVM — detailed design and project structure

Breadcrumb: xrplh-11 (fit) → xrplh-15 (signing + estimate) → **xrplh-16** (this). Codebase: PRIVAI2-TR1\chainaim-router-private-ai-2.
Status: DESIGN ONLY. Written 2026-10-24 22:15 (UTC-05:00).
Tags: [SDK] DESIGN/REF/*.mjs|js · [DECK] workshop pptx · [GUIDE] integration-guide · [AGENTS] sdk/AGENTS.md · [CODE] this repo ·
[ASSUME] unverified, check named. Still unread: x402.md, api-reference.md, llms.txt (client error) — see §9.

---

## 0. Answer in one paragraph
Yes, it is workable with every characteristic kept. The tenant's Strands agent (buyer, registered AP4M Agent wallet on XRPL EVM
Testnet) masks on its PC, asks ChainAim's **own merchant** for a quote, receives an x402 402, signs an EIP-712 Voucher, and gets the
answer. ChainAim's merchant (custom payout wallet, our own Merchant ID) verifies the Voucher, runs the masked inference through the
existing gateway by URL, **redeems** the Voucher on-chain (VoucherRedeemed), and returns the answer. The AP4M service then **settles**
RLUSD from the PooledEscrowVault to ChainAim's payout wallet (ClaimPaid + SettlementRecorded + receipt). All new code lives in
`hack/ap4m/`, which reaches `services/*` only by URL.

## 1. Fixed requirements (owner, 2026-10-24) and how each is met
| # | Requirement | Design |
|---|---|---|
| R1 | Chain = XRPL EVM sidechain Testnet (1449000) | All AP4M calls via `/public/config` RPC; no XRPL L1 in this path |
| R2 | Buyer EVM wallet registered as Agent Principal | Portal "My setup": the buyer wallet is the funding/Principal wallet **and** the Agent wallet (allowed: "it may be your funding wallet" [GUIDE]). Registration is portal-only, not code [AGENTS] |
| R3 | Seller = custom wallet, not one of the 4 pool merchants | Portal "My setup → Merchant → add own wallet" [DECK 13 step 04] → our own `MERCHANT_ID` + payout. Payout must differ from agent/funding wallet [GUIDE]. Submitter key (gas for redeem) may be the payout wallet [SDK example] |
| R4 | Seller does the work under the x402 Voucher flow | Custom merchant: 402 → Voucher → verify → **infer** → redeem → release (§4) |
| R5 | Final RLUSD movement | Precise terms: **redemption** = `redeemVoucher` records the claim (no token moves); **settlement** = `settle` moves RLUSD vault → payout [DECK 6]. Both are shown; judges check the payout balance changed [GUIDE] |
| R6 | Show the functionality | 3-minute live script (§7) covering the DECK 16 checklist incl. over-cap refusal |

Characteristics kept from the app: masking on the PC (Bedrock and providers see placeholders only), Jev/route-engine routing in the
gateway, Strands + Bedrock agent, session ceiling (`--max-spend`), answer restored only on the PC, "no answer → no charge",
idempotent retries, decision ledger with no text.

## 2. Roles
| AP4M role [DECK 7] | Who | Key / wallet |
|---|---|---|
| Agent Principal (funds, authorises) | Tenant org | Buyer EVM wallet (funding) |
| Agent (decides, signs Vouchers) | Tenant's Strands agent on the PC | Same buyer EVM wallet (`AGENT_PRIVATE_KEY`) |
| Merchant / Payee facilitator | ChainAim merchant (`hack/ap4m` merchant) | Submitter key (`MERCHANT_SUBMITTER_KEY`, gas) |
| Payout address | ChainAim seller wallet | Custom EVM wallet, key held offline |
| Registry, PaymentLedger, Vault, settlement | AP4M service + contracts | Service keys — never ours [AGENTS] |
| Inference | ChainAim gateway (unchanged) → Bedrock / OpenRouter | Gateway key (existing) |

## 3. Boundary rule (from xplh-4, applied to TR1)
```
hack/ap4m ──import──▶ hack/ap4m/vendor (official AP4M files, unmodified) and npm deps only
hack/ap4m ──HTTP────▶ services/gateway  (masked inference: /v1/chat/completions, /internal/capacity, /healthz)
hack/ap4m ──HTTP────▶ services/client-privacy (NEW, 127.0.0.1 on the tenant PC: /extract /mask /restore)
hack/ap4m ──HTTP────▶ AP4M service + XRPL EVM RPC
services/* ──never──▶ hack/*
```
Why `services/client-privacy`: today the PC-side masking code is in `services/paywall/scripts/{client-mask,prompt-scan,extract}.ts`
and imports `services/gateway/src/privacy/*` [CODE]. Importing it from `hack/` breaks the rule. A thin local HTTP wrapper around the
existing functions keeps the code unchanged and the data on the PC (loopback only, refuses non-127.0.0.1 binds).
Enforcement: `hack/ap4m/scripts/check-boundaries.mjs` (fails on any import path containing `services/`) + `services/**` grep for
`hack/`; both run in `npm test`.

## 4. The flow (one private ask)
```
TENANT PC                                          CHAINAIM (hack/ap4m merchant)                 AP4M / XRPL EVM
1  user → Strands agent (Bedrock; prompt masked via client-privacy)
2  agent calls tool chainaim_private_ask(file, question)
3  tool: client-privacy /extract + /mask  → masked request + restore map (map stays on PC)
4  tool: local estimate (§6) → refuse if > min(session remaining, --max-price, cap − redeemed)
5  POST /jobs {masked request, declared work} ───────▶ recount (placeholders, bytes, max_tokens), quote,
   ◀──────────── {jobId, quoteWei, breakdown, expiresAt}      store job (sqlite), no payment yet
6  buyResource(GET /resource, X-AP4M-CHANNEL-ID, X-ChainAim-Job via requestFetch)
                                                  ───▶ binding open? our merchantId+payout? job valid?
                                                        challenge(amount = job.quoteWei, validBefore ≤ +300 s) ─▶ 402
7  SDK checks scheme/fixed/payTo/amount ≤ max/amount+redeemed ≤ cap/window → signs EIP-712 Voucher (no gas)
8  GET /resource + PAYMENT-SIGNATURE ─────────────────▶ prepareX402Redemption (verify, no chain write)
                                                        gateway /v1/chat/completions (masked) ── Bedrock/OpenRouter
                                                        if inference failed → 502, NOT redeemed, agent not charged
                                                        sendTransaction(redeemVoucher) ──────────────────────▶ VoucherRedeemed
                                                        verifyMerchantResourceRedemption ◀───────────────────
   ◀──────────── 200 {resource: masked answer, breakdown} + PAYMENT-RESPONSE(tx)
9  SDK verifies receipt, calldata, claimId, event, finality
10 tool: client-privacy /restore → answer shown on PC; model gets masked answer or pass-through note (existing modes)
11 ops: record-redemption + settle (auto, or on demand) ─────────────────────────────────────▶ vault → payout RLUSD, receipt_url
12 ledger line: {jobId, agent, channelId, claimId, redeemTx, settleTx, quote breakdown, model, dataClass} — no text
```
Timing guard: steps 8 inference + redeem must finish before `challenge.validBefore − --merchant-cutoff-seconds` [SDK]; the merchant
refuses (409) rather than redeeming late. `--inference-timeout-ms` default 90000.
Idempotency: agent side `operation = jobId` (SDK keeps `purchase.json`); merchant side sqlite keyed by voucher digest returns the
same stored answer on retry and never redeems twice (same pattern as the kit merchant [SDK]).

## 5. Merchant internals (why custom, what it reuses)
The kit merchant (`createX402Merchant`) sells one static JSON at `GET /resource`, one price per state dir, no body [SDK]. Ours
reuses the same `@ap4m/sdk` functions the kit imports — `readPaymentChannelBinding`, `buildMerchantResourceChallenge`,
`buildX402Challenge`, `encodeX402PaymentRequired`, `prepareX402Redemption`, `verifyX402Payment`, `derivePaymentClaimId`,
`readPublicLogs`, `verifyMerchantResourceRedemption`, `buildX402RedemptionResponse` — and adds: job lookup, per-job amount,
inference between verify and redeem, stored result per voucher. [ASSUME] exact signatures: copy them from the kit's call sites first,
then confirm in the installed `@ap4m/sdk`.

## 6. Cost planning — options (pick one, flag-switchable: `--pricing fixed|tiers|quote`)
| Option | How | Pros | Cons / risk |
|---|---|---|---|
| A fixed | One price per ask (e.g. 0.10 RLUSD) | Zero risk; identical to kit behaviour | Ignores size; small asks overpay |
| B tiers | S/M/L by masked input tokens + max_tokens (e.g. ≤2k/512 → 0.05, ≤8k/1024 → 0.10, ≤32k/2048 → 0.25) | Simple, explainable on stage; bounded | Coarse; needs per-challenge amount |
| **C quote (recommended)** | Per-job quote from formula below, stated in `/jobs` and used as the challenge amount | Matches real cost; shows "agent sees price, decides" | Needs per-challenge amount [ASSUME, §9 check 1] |

Formula (xrplh-10/15, pure function `estimate.ts`, same code on agent and merchant):
```
inTok = Bedrock CountTokens(masked request)            when --token-count bedrock and model supports it (free, matches billing)
      = ceil(bytes / charsPerToken × (1 + inputMargin)) otherwise
outTok = max_tokens (cap → quote is an upper bound, never exceeded)
modelUsd = (inTok·inPerM + outTok·outPerM·(1 + reasoningFactor)) / 1e6        prices from config/catalog*.json pricing
dataUsd  = perMaskedField·fields + perKB·KB
total    = clamp(roundUp(fixed + dataUsd + costShare·modelUsd, 1e-6), minimum, maximumPerCall) → parseUnits(total, 18)
```
No refund/true-up: vouchers are cumulative and `redeemed` only rises [AGENTS, DECK 12], so overpayment vs actual tokens is not
returned; keep `costShare` and the cap small. Show "quoted vs actual tokens" in the receipt for transparency.
Fallback order if check 1 fails: C → B via separate fixed merchants per tier → A.

## 7. Showing it (3 minutes, live) — maps to DECK 16 / GUIDE judging
1. `status` → Agent registered, Channel open, cap 1 RLUSD, redeemed 0, payout balance X.
2. Ask 1 (discharge note, PHI): masked preview on PC → quote 0.10 → 402 → Voucher → answer restored on PC → VoucherRedeemed tx link.
3. Ask 2 (supplier dispute): second voucher, cumulative 0.20.
4. Over-cap: cap nearly used → quote exceeds `cap − redeemed` → agent refuses before signing and says so (no human).
5. `settle` → ClaimPaid + SettlementRecorded tx, receipt_url, payout balance X + 0.20.
6. Ledger view: two lines joining agent ↔ channel ↔ claim ↔ model, no personal data.

## 8. Project structure
```
PRIVAI2-TR1\chainaim-router-private-ai-2\
├─ services\                      (existing infra; unchanged except one new wrapper)
│  ├─ gateway\                    unchanged — masked inference, routing, ledger
│  ├─ presidio\  analyst\  web\   unchanged
│  ├─ paywall\                    unchanged now (XRPL L1); dormant for TR1, removable after AP4M works (cleanup pass)
│  └─ client-privacy\             NEW thin HTTP wrapper (127.0.0.1 only) over existing extract/mask/restore code
│     ├─ src\main.ts              --port 8787 --bind 127.0.0.1 --presidio-url --names
│     ├─ src\routes.ts            POST /extract /mask /restore /scan ; GET /healthz
│     └─ test\
├─ packages\route-engine\         unchanged
├─ hack\                          NEW — Saturday code; nothing imports it
│  └─ ap4m\
│     ├─ package.json             deps: ethers@6.17.0, @ap4m/sdk (service tgz), @strands-agents/sdk, @aws-sdk/client-bedrock-runtime, zod
│     ├─ .env.example             names only: AP4M_API_URL, TEAM_NAME, AGENT_PRIVATE_KEY, MERCHANT_ID, MERCHANT_PAYOUT,
│     │                           MERCHANT_SUBMITTER_KEY, GATEWAY_URL, GATEWAY_KEY, CLIENT_PRIVACY_URL, AWS_REGION
│     ├─ README.md                what pre-existed vs built at the event; run order
│     ├─ vendor\                  official AP4M files, unmodified + SOURCES.md (URL, date, sha256)
│     │  ├─ ap4m-x402.mjs
│     │  └─ ap4m-hackathon-sdk.cjs
│     ├─ config\pricing.json      fixed/data/model/tiers/min/max (prices only)
│     ├─ src\
│     │  ├─ shared\
│     │  │  ├─ config.ts          flags+env; loads /public/config and /public/x402-context once
│     │  │  ├─ estimate.ts        pure cost function (§6), used by both sides
│     │  │  ├─ token-count.ts     bedrock|chars counter
│     │  │  └─ ledger.ts          JSONL writer, numbers/ids only
│     │  ├─ merchant\             ChainAim seller
│     │  │  ├─ main.ts            --port 4308 --resource-url --pricing --merchant-cutoff-seconds --inference-timeout-ms --state-dir
│     │  │  ├─ http.ts            POST /jobs, GET /resource, GET /quote/:jobId, GET /healthz
│     │  │  ├─ jobs.ts            sqlite: jobs, challenges, payments, results
│     │  │  ├─ x402-merchant.ts   challenge → verify → infer → redeem → verify (SDK primitives)
│     │  │  └─ gateway-client.ts  the ONLY call into ChainAim infra (HTTP)
│     │  ├─ agent\                tenant buyer
│     │  │  ├─ main.ts            --docs --max-spend --max-price-rlusd --channel-id|--channel-cap --state-dir --answer-to-model
│     │  │  ├─ strands-agent.ts   Agent + BedrockModel + one tool, sequential
│     │  │  ├─ private-ask-tool.ts  mask (HTTP) → estimate → /jobs → buyResource → restore (HTTP)
│     │  │  ├─ ap4m-rail.ts       buyResource wrapper, requestFetch adds X-ChainAim-Job, remaining = min(ceiling, cap−redeemed)
│     │  │  └─ privacy-client.ts  HTTP client for services/client-privacy
│     │  └─ ops\                  setup-channel.ts (signIn+requestChannel), status.ts, settle.ts, close.ts, receipt.ts
│     ├─ demo\                    run-demo.ps1 (§7), over-cap.ps1, reset.ps1
│     ├─ scripts\check-boundaries.mjs
│     └─ test\                    estimate, jobs/idempotency, merchant against a stub gateway, boundary check
└─ DESIGN\                        xrplh-15, xrplh-16 (this)
```

## 9. Checks before building (blocking marked *)
1.* x402.md: may each challenge carry a different amount for one merchant? (decides pricing C/B/A)
2.  Portal: confirm "add own Merchant wallet" yields our own MERCHANT_ID while cross-team payments are off (Channels pay own team's
    merchant [AGENTS]).
3.  `@ap4m/sdk` primitive signatures (§5).
4.  Bedrock CountTokens support for the Nemotron model id.
5.  Resource URL: keep `https://<host>/resource` + job header (no URL change needed; avoids the parseX402ResourceUrl question).
6.  Merchant public URL must be HTTPS if the agent runs on another machine [AGENTS]; same PC → http://127.0.0.1 is allowed [SDK].

## 10. Build order (each step ends green)
1. vendor + config + estimate.ts + tests.  2. services/client-privacy + tests.  3. ops: setup-channel/status (live, read-only first).
4. merchant against stub gateway (tests) → live with gateway.  5. agent rail + tool → one live paid ask.  6. settle/receipt/ledger.
7. demo scripts + over-cap.  8. boundary check in npm test.  Tag after each.
