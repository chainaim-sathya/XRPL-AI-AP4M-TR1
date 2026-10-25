# xrplh-11 — ChainAim on AP4M: how the private-AI gateway fits the Agentic Finance track

Breadcrumb: DESIGN/README.md → xrplh-8 (Strands vs Bedrock) → xrplh-10 (pricing) → **xrplh-11** (this).
Status: **DESIGN ONLY — no code written or changed.** Written 2026-10-24 18:10 (UTC-05:00).

Tags: [DECK] DESIGN/Mastercard_AP4M_XRPL_Hackathon_Workshop.pptx (read today) · [GUIDE] hackathon.ap4m.build/integration-guide ·
[KIT] ap4m-agent.js in repo root · [SDK] hackathon.ap4m.build/sdk/ap4m-x402.mjs · [CONFIG] hackathon.ap4m.build/public/config ·
[CODE] this repo · [CHAIN] read on XRPL EVM Testnet today · [ASSUME] not verified — the check is named.

---

## 0. Bottom line

1. **ChainAim is already the "load-bearing payment" the judges ask for.** The agent cannot get the answer without paying; the
   payment buys a privacy-preserving inference. That is exactly [GUIDE] "use case clarity: the payment is load-bearing".
2. **Change one thing: the rail under the existing Strands tool.** Today `chainaim_private_ask` pays per call with x402 "exact"
   on XRPL L1 via t54 [CODE agent-core.ts]. For AP4M it pays with an **AP4M voucher on an open Channel** (`buyResource()` [SDK]).
   The Strands loop, Bedrock model, masking and gateway stay as they are.
3. **The two legs become two Channels under the same rules.** Leg A: tenant's agent → ChainAim (real). Leg B: ChainAim's
   router agent → model-provider merchant (demonstrated with a stand-in merchant; real providers are still paid in USD/API key).
   This is the deck's "chained payments / one budget, several merchants" story [DECK slide 2].
4. **Safety = three independent fences, each provable on stage:** on-chain cap (AP4M), agent-side session ceiling (code
   exists: `--max-spend`), and data fence (masking — personal data never leaves the tenant machine). Over-cap attempt rejected
   is a required demo item [DECK slide 16].
5. **Keep it simple:** one hero use case, one fixed price, one Channel per tenant agent, live in ~3 minutes.

---

## 1. What the track asks for (verified)

| Ask | Source | ChainAim answer |
|---|---|---|
| Know Your Agent: only verified agents transact | [DECK 1, 6, 11] ParticipantRegistry, PSP-attested | Tenant agent wallet registered via portal (`0x139E…bf30`, done); ChainAim merchant payout bound in registry |
| Funded ASL: cap the agent can't exceed | [DECK 6, 12] `settled ≤ redeemed ≤ cap` | One Channel per tenant agent, cap = tenant's monthly AI budget slice (e.g. 5 RLUSD) |
| EIP-712 vouchers, one HTTP round trip | [DECK 10] [SDK] header `PAYMENT-REQUIRED` → `PAYMENT-SIGNATURE` → `PAYMENT-RESPONSE` | Paywall answers 402 with AP4M requirements; agent tool signs voucher; paywall releases the answer |
| RLUSD settlement, merchant balance changes | [GUIDE judging] | ChainAim payout wallet balance before/after shown (same BEFORE/AFTER pattern as e2e-private-ask.ts [CODE]) |
| Autonomy: agent reads 402, decides, signs, no human | [GUIDE judging] | Strands model decides to call the tool; tool signs within cap; no prompt to the user |
| On-chain proof: `VoucherRedeemed` at PaymentLedger | [GUIDE] ledger `0xcAB42800…aE91` [CONFIG] | Printed tx + explorer link per call |
| Creativity: multi-step reasoning, real data | [GUIDE] | Agent reasons over the tenant's own confidential documents; privacy routing (PHI → no-collection providers) |
| AWS: Strands loop + Bedrock inference | [CODE xrplh-8 §1, agent.ts] | Already built: Strands TS SDK 1.20.0, `BedrockModel` (Nemotron 3 Nano, ap-southeast-2), Bedrock sees masked text only |

---

## 2. Roles: mapping ChainAim onto the AP4M reference model [DECK slide 7]

| AP4M role | ChainAim, Leg A (sell inference) | ChainAim, Leg B (buy inference) |
|---|---|---|
| Agent principal (funds, authorises) | The tenant organisation (clinic, SMB) | ChainAim (the company) |
| Agent | Tenant's Strands buyer agent | ChainAim's router (Jev / route-engine) acting as a buying agent |
| Merchant | **ChainAim gateway** (paywall = x402 merchant) | Model provider (stand-in merchant in the demo) |
| Payout address | ChainAim seller wallet (EVM) | Provider's payout wallet (pool wallet in the demo) |
| Resource released | The masked-in, restored-locally answer | One model completion |

Key separation the rules require [GUIDE]: agent wallet ≠ funding wallet ≠ payout address. Leg B's agent wallet must not be
ChainAim's Leg A payout wallet.

---

## 3. The flow (Leg A — the hero path)

```
Tenant PC                                   ChainAim (paywall → gateway)              XRPL EVM Testnet
─────────                                   ───────────────────────────               ────────────────
1 user asks Strands agent (Bedrock, masked prompt)
2 agent decides: call chainaim_private_ask(file, question)
3 tool masks document on the PC (existing)
4 tool GET /resource  ──X-AP4M-CHANNEL-ID──▶  402 + PAYMENT-REQUIRED (fixed price,
                                              payTo = ChainAim payout, ledger, cap info)
5 tool checks price ≤ maximumAmount, amount+redeemed ≤ cap   (SDK does this check [SDK buyResource])
  and session ceiling (--max-spend, existing)
6 tool signs EIP-712 voucher (no gas)  ──PAYMENT-SIGNATURE──▶ verify voucher, redeem on-chain ──▶ VoucherRedeemed
7                                             run masked ask (gateway, unchanged)
8 ◀── answer + PAYMENT-RESPONSE (claimId, tx)
9 tool restores answer on PC; returns spent/remaining read from the Channel (chain is the truth)
...later: settle() → ClaimPaid + SettlementRecorded → RLUSD to ChainAim payout ──────────────▶ balance changes
```

What changes vs today [CODE]: steps 4–6 and 8 (rail). Everything else is existing code.

---

## 4. Constraints found that shape the design

1. **AP4M x402 supports fixed prices only.** `buyResource()` rejects a challenge unless `pricingMode === 'fixed'` [SDK], and
   `createX402Merchant()` "serves one fixed-price resource" [SDK header]. So xrplh-10's variable price (fixed + data + model)
   **cannot ride AP4M during the hackathon.** Design: one fixed price per resource (e.g. `/v1/private-ask/resource` at 0.10 RLUSD);
   if tiers are wanted, expose separate fixed-price resources (standard vs PHI). Keep xrplh-10 for the L1 rail.
2. **The merchant redeems, from its own wallet** [SDK header]: ChainAim needs an EVM merchant wallet holding testnet XRP for gas.
   The agent signs vouchers without gas, but needs gas once to open the Channel (it has 98.83 XRP [CHAIN]).
3. **Channel validity window** `validAfter … validBefore` is enforced by the SDK [SDK]; channels auto-close at event end [GUIDE].
4. **Idempotency is built in:** `buyResource` keeps the signed purchase in a state directory and resumes it after a crash
   instead of paying twice, keyed by an `operation` name [SDK]. Map ChainAim's existing invoice/ask id to `operation`
   — this solves xrplh-6's ask/payment atomicity concern for the AP4M rail.
5. **SDK is hackathon-only** ("must not be used outside of the hackathon context" [GUIDE]). Keep it behind a rail interface so the
   production L1/t54 path is untouched.
6. Docs `x402.md` and `api-reference.md` need a sign-in (HTTP 401 today); the merchant-side details below are from the SDK
   source only. [ASSUME] merchant API shape — check by reading `createX402Merchant` and `example-x402-merchant.mjs` before building.

---

## 5. Strands: where the agent code changes (analysis of current code)

Current [CODE services/paywall/scripts/agent.ts, agent-core.ts]:
- `buildAgent()` → `new Agent({ model: BedrockModel, tools:[askTool(session)], toolExecutor:"sequential" })`.
- `AskSession` holds `ceiling` (`--max-spend`, default 0.05) and `spent`; tool replies carry `spent` / `remaining`.
- The tool masks on the PC, pays via XRPL L1 x402 (`xrpl.ts`, `XrplSigner`), returns masked answer, restores locally.

Design (when building — not now):
- Add a **payment rail seam**: `PaymentRail` with `quote()` / `pay(operation)` / `remaining()`; implementations
  `xrpl-t54` (today) and `ap4m-channel` (new). Selected by flag `--rail xrpl-t54|ap4m` (default `xrpl-t54`, so nothing breaks).
- `ap4m-channel` flags: `--ap4m-api-url` (default https://hackathon.ap4m.build), `--channel-id` (else open one with
  `--channel-cap`, default 5), `--ap4m-state-dir`, `--agent-key-env` (default AGENT_PRIVATE_KEY via the existing
  key-file pattern), `--max-price-rlusd`.
- `remaining` = min(session ceiling − spent, channel cap − redeemed). The model sees both, so the agent can reason
  ("I have 0.30 RLUSD left; this needs 0.10") — visible autonomy within limits.
- System prompt adds one rule: "never retry a refused payment; report it". Makes the over-cap demo clean.

No Python port, no managed Bedrock Agents (reasons in xrplh-8 still hold).

---

## 6. Registry ("know who the agent is for and from")

Verified: registry contract `participantRegistry 0x4cF27435…D1E8` [CONFIG]; registration is PSP-sponsored through the
portal, agent wallet signs once to prove ownership [GUIDE, DECK 11]. Teams do not write to the registry themselves.

How ChainAim connects to it (design):
1. **Identity in, not just payment in.** On each paid call the paywall already learns the agent address and channelId from the
   voucher. The gateway's **decision ledger** [CODE data/ledger] gets three new fields: `agent`, `channelId`, `claimId`.
   Result: every privacy decision (what was masked, which model, PHI or not) is joined to a registered agent and an on-chain
   claim — "who asked, on whose behalf, what it cost, where the data went", with no personal data in the record.
2. **Refuse unknown agents before work.** The x402 check already ties the channel to a registered agent (`channel.agent ===
   wallet.address` [SDK]). ChainAim adds nothing on-chain; it trusts the PaymentLedger's registry check at `openChannel()` [DECK 6].
3. **Principal display.** Show the principal (tenant) recorded for the agent in the receipt view. [ASSUME] the registry
   exposes agent → principal reads; check the registry ABI in `@ap4m/sdk` before promising this on stage.

---

## 7. Leg B (ChainAim pays model providers) — keep honest

Reality: providers (OpenRouter, Bedrock) are paid in USD by API key today. Two options:

| Option | What it shows | Effort | Honest label |
|---|---|---|---|
| B0 — show cost pass-through only | Leg A receipt lists the model's raw cost (xrplh-10 already computes it) | none | "provider paid in USD today" |
| **B1 — stand-in provider merchant (recommended if time)** | Router opens its own Channel to a second merchant ("inference provider", pool wallet); each completion = one voucher | medium | "demo provider merchant; real providers not yet on AP4M" |

B1 makes the deck's "one request → several merchants" story real: one user question triggers Leg A (tenant → ChainAim) and Leg B
(ChainAim → provider), each under its own cap. Do B1 only after Leg A passes live.

---

## 8. Use case (pick one hero)

**Hero: "Private AI analyst for a regulated small business"** (procurement / back-office — [DECK 15] procurement).
- The finance agent of a clinic or SMB has a 5 RLUSD AI budget (the Channel cap).
- It answers questions over confidential documents (supplier dispute, discharge note — already in `rig/tenants` [CODE]).
- Each answer is bought from ChainAim with a voucher; names, accounts, IDs never leave the PC; PHI goes only to
  no-data-collection models.
- When the budget runs out, the next ask is refused on-chain and the agent says so — no human in the loop, no overspend.

Why it convinces Mastercard + AWS: trust controls (identity, cap, vouchers, settlement) applied to the riskiest thing agents buy —
inference over private data — on Strands + Bedrock, with Bedrock seeing masked text only.

---

## 9. 3-minute demo script (maps to [DECK 16] checklist)

| t | Show | Checklist item |
|---|---|---|
| 0:00 | Portal: agent registered, merchant payout bound, budget | PSP-attested identities |
| 0:20 | Agent opens Channel, cap 0.30 RLUSD (small on purpose) | Funded channel cap |
| 0:40 | Ask 1 → 402 shown → voucher → masked answer restored locally | HTTP 402 · agent-signed voucher · immediate release |
| 1:20 | Explorer: `VoucherRedeemed` at PaymentLedger | VoucherRedeemed claim |
| 1:40 | Asks 2–3, then ask 4 exceeds cap → refused before signing, agent reports | Over-cap attempt rejected |
| 2:20 | settle() → `ClaimPaid` + `SettlementRecorded`, ChainAim balance before/after | RLUSD settlement |
| 2:45 | Gateway ledger line: agent, channelId, claimId, masked counts, model — no personal data | Know who / for whom |

---

## 10. Work split (for later — nothing started)

AI can do: rail seam + `ap4m-channel` rail; paywall AP4M merchant route; ledger fields; tests over stubs; demo runbook.
Manual (owner): portal step 2 (merchant payout), budget deposit confirmation, ChainAim EVM merchant wallet + gas,
`AGENT_PRIVATE_KEY` into the key file, live runs.

Open questions:
1. Fixed price for the hackathon resource: 0.10 RLUSD (xrplh-10 default fixed) or 0.01 (today's paywall)?
2. Is ChainAim's merchant your team's portal merchant (pool wallet) or a payout wallet you control? (Leg A settlement target.)
3. Leg B: B0 or B1?
