# xrplh-17 — Full session record: mid-check-2, Track 1 (Agentic Finance, Mastercard AP4M on XRPL EVM)

Session: 2026-10-24 21:13 → 22:15 (UTC-05:00), Claude chat with device bridge.
Codebases: started on PRIVAI2\chainaim-router-private-ai-2; from 21:42 on **PRIVAI2-TR1\chainaim-router-private-ai-2** (going forward).
Breadcrumb: xrplh-11 (AP4M fit) → xrplh-13 (previous session) → xrplh-15 (signing + estimate) → xrplh-16 (TR1 design + structure) → **xrplh-17** (this).

---

## Turn 1 (21:13) — Recap, signing analysis, EVM/AP4M plan, cost estimate research

**Ask.** Read mid-check-1 and earlier Agentic Finance chats, all AP4M REF files (deck, ap4m-agent.js, ap4m-hackathon-sdk.js,
ap4m-x402.mjs, example agent/merchant, check-rlusd, create-evm-wallet, guide link), recap the design; explain how RLUSD moves buyer →
seller in the current XRPL code; what it takes to do it on XRPL EVM with the Agent Principal in the Mastercard registry and EIP-712
vouchers releasing inference (gateway runs masked calls); research job cost estimation; official docs only.

**Read.** Past chat mid-check-1 (search); PROJECT_CONTEXT.md; DESIGN/REF all files (pptx text extracted, 20 slides);
services/paywall/scripts/{signer.ts, xrpl.ts, agent-core.ts (parts), private-ask-core.ts (grep)}; services/web/src/xrpl-payment.ts;
services/paywall/src/{app.ts, routes.ts, config.ts (grep)}; DESIGN/xrplh-10, xrplh-11.
Web: hackathon.ap4m.build/integration-guide, /sdk/AGENTS.md (both read); /docs/x402.md, /llms.txt, /llms-full.txt → client error
(NOT read). AWS Bedrock count-tokens doc; OpenRouter FAQ; arXiv 2607.05316.

**Findings.**
- Today (XRPL L1): buyer seed (`XRPL_BUYER_SEED_TESTNET`) → `seedSigner` → `payAndFetch` reads 402, refuses above remaining →
  `preparePayment` builds full Payment (Amount = SendMax RLUSD, Destination payTo, Memo invoiceId + InvoiceID sha256, Sequence, Fee,
  LastLedgerSequence) → buyer signs → `checkSigned` (fields unchanged, Account, verifySignature) → PAYMENT-SIGNATURE → paywall
  invoice replay guard → t54 facilitator verifies → gateway runs → facilitator submits the buyer-signed blob only if response < 400.
- AP4M (XRPL EVM 1449000): agent never signs a token transfer. Agent signs sign-in message, one channel-request tx (gas), EIP-712
  Voucher `{bytes32 channelId, uint256 cumulativeAmount}` (domain "AP4M Payment Ledger" v1, chainId, verifyingContract PaymentLedger),
  close checkpoint. Merchant sends `redeemVoucher` (gas) → VoucherRedeemed, no token transfer. AP4M service settles vault → payout
  (ClaimPaid + SettlementRecorded). Rule: settled ≤ redeemed ≤ cap. Registry onboarding is portal-only.
- Gaps for inference: kit `createX402Merchant` serves one static JSON at GET /resource, one price, no body → custom merchant from the
  same @ap4m/sdk primitives; job staging (POST /jobs + job header via buyResource's `requestFetch`); pricingMode must be `fixed` →
  per-job quote as challenge amount [ASSUME service accepts varying amounts]; custom order verify → infer → redeem → release within
  ≤300 s window; agent response ≤128 KiB, 150 s timeout.
- Estimate: Bedrock CountTokens = exact input tokens, free, matches billing, not all models; OpenRouter cost known only after;
  output length not predictable via APIs (research needs hidden states) → use max_tokens cap as upper bound. Formula saved.

**Output.** `DESIGN/xrplh-15-AP4M-EVM-INFERENCE-SIGNING-AND-ESTIMATE-2026-10-24T2145.md` (written to PRIVAI2; copy present in TR1).

## Turn 2 (21:42) — "Custom merchant" meaning; switch to TR1

**Answer.** A merchant = server that issues the 402, receives the voucher, redeems it, hands over the resource. Kit merchant sells
the same fixed JSON to everyone, only GET /resource, no body, one price. Ours uses the same SDK payment functions but runs inference
between "voucher verified" and "redeemed". Impact table: new paywall routes, new deps (ethers, @ap4m/sdk), EVM submitter key + payout;
gateway, masking, routing unchanged; Strands agent gets rail switch; web console unchanged for now.
TR1 verified: same paywall/agent/payment files (same line counts); DESIGN has xrplh-15; x402.md etc. not yet in REF.

## Turn 3 (21:45) — Two merchant paths?

**Answer.** No. In TR1 run one active merchant path (AP4M) via start-up setting `PAYMENT_RAIL=ap4m|xrpl-t54` (TR1 default ap4m).
L1 code stays dormant, not deleted (≈20 files depend on it: web Crossmark pay, pay.ts, private-ask, rig, agent, tests).
AP4M merchant sells the private chat answer only; scan/mask run on the PC (xrplh-9).

## Turn 4 (21:47) — Remove unneeded files after Mastercard works?

**Answer.** Yes, as a separate cleanup pass: tag `ap4m-working`; trace imports (shared pieces like `services/web/src/balance.ts`
LedgerError kept/moved); delete pure L1/t54 code (Crossmark signer, wallet-entry, xrpl-payment, wallet.js, signer.ts, payment parts of
xrpl.ts, pay.ts, trust-line/buy-rlusd/send-xrp scripts, t54 middleware, the switch, their tests, @x402/*, x402-xrpl, xrpl deps);
update docs; all tests + live AP4M run. AI does edits/tests; owner approves delete permission (and git tag if locks block).
PRIVAI2 keeps L1 for the "Why Not" track.

## Turn 5 (21:57) — Make AP4M workable for the inference app; hack folder; cost options

**Requirements (owner).** XRPL EVM sidechain; XRPL EVM Testnet wallets; buyer EVM wallet registered as Agent Principal; seller is a
custom wallet, not one of the 4 pool merchant IDs; seller works under x402 voucher flow; final RLUSD movement; show the functionality;
cost planning options; simple but effective.

**Read.** Past chats xplh-4 (import boundary rule) and Chainaim-router-restructure-1 (hack/ carve-out); TR1 root package.json
(no workspaces), packages/ (route-engine only), services/ (analyst, gateway, paywall, presidio, web); no hack/; config/catalog.bedrock.json
pricing (Nemotron 0.0618 / 0.2472 USD per 1M); imports of client-mask.ts / prompt-scan.ts (they import services/gateway/src/privacy/*).

**Key points.**
- Buyer wallet = funding (Principal) + Agent wallet (allowed by guide). Seller: portal "add own wallet" → own Merchant ID + payout
  (payout ≠ agent/funding).
- Correction on terms: redemption records the claim; settlement moves RLUSD. Both shown.
- New `services/client-privacy` (127.0.0.1 HTTP wrapper over existing extract/mask/restore) so `hack/` keeps the URL-only rule.
- Cost options behind `--pricing fixed|tiers|quote`: A fixed, B tiers, C per-job quote (recommended; needs per-challenge amount check).
  No refunds (vouchers only count up).

**Output.** `DESIGN/xrplh-16-TR1-AP4M-INFERENCE-PROJECT-STRUCTURE-2026-10-24T2215.md` (requirements, roles, boundary, flow,
merchant internals, cost options + formula, 3-min demo, project tree, checks, build order).
Manual step 1 given: save hackathon.ap4m.build/docs/x402.md (signed in) as DESIGN/REF/x402.md.

## Turn 6 (22:01) — Show the project structure
Full tree from xrplh-16 §8 shown in chat (see that file).

## Turn 7 (22:03) — Separating hack code from privacy infra

**Recommendation.**
- While building: one repo (TR1) with the internal boundary (`services/` private infra; `hack/ap4m` HTTP-only; check-boundaries).
  Add `hack/ap4m/contracts/` with JSON schemas of the gateway and client-privacy HTTP APIs (copied, not imported), tested on both sides.
- At submission: public repo = `hack/ap4m` (agent, merchant, ops, demo, tests, vendor, contracts, .env.example, README pre-existing vs
  built). Private (TR1) = services/*, route-engine, config catalogs, keys/.env/wallets/data, DESIGN.
- client-privacy stays private, shipped as a docker image so the public agent calls http://127.0.0.1:8787. estimate.ts is public.
- Open: whether organizers require all running code public (unknown; also open in xplh-4).
- Order: build in TR1 → tag ap4m-working → copy hack/ap4m to public repo → publish infra images → point .env.example → run demo from
  public repo. AI: copy, README, image build files. Owner: create public GitHub repo, publish images.

## Turn 8 (22:13) — Save session
This file.

---

## State at end of session
- Design only; no code changed in either codebase.
- Files written this session: xrplh-15 (signing + estimate), xrplh-16 (TR1 design + structure), xrplh-17 (this record).

## Open checks (blocking marked *)
1.* DESIGN/REF/x402.md (and api-reference.md, llms.txt): may each 402 challenge carry a different amount for one merchant?
    Decides pricing C → B → A.
2.  Portal: adding own merchant wallet gives our own MERCHANT_ID while cross-team payments are off.
3.  @ap4m/sdk primitive signatures (install tgz from the AP4M service).
4.  Bedrock CountTokens support for the Nemotron model id.
5.  Organizers' rule on public code.
6.  Fixed price component: 0.10 vs 0.01 RLUSD (carried from mid-check-1).

## Exact next step
Owner saves x402.md (+ api-reference.md, llms.txt) into DESIGN/REF; then build order xrplh-16 §10 step 1
(vendor + config/pricing.json + estimate.ts + tests in hack/ap4m).
