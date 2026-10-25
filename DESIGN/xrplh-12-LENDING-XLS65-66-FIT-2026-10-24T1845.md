# xrplh-12 — ChainAim for the Lending & Borrowing track: private, deterministic off-chain underwriting for XLS-65/66

Breadcrumb: DESIGN/README.md → xrplh-3 (Layer 3: ACTUS + XLS-66) → xrplh-11 (AP4M) → **xrplh-12** (this).
Status: **DESIGN ONLY — no code written or changed.** Written 2026-10-24 18:45 (UTC-05:00).

Tags: [SPEC66] XRPL-Standards XLS-0066 README · [SPEC65] XLS-0065 README · [SDK] npm xrpl@5.3.0 type definitions ·
[NEWS] crypto.news on xrpld 3.4.0 (2026-09) · [CODE] this repo · [CHAT xplh-3] past chat 2026-10-23 · [ASSUME] not verified — check named.

---

## 0. Bottom line

1. **XLS-66 deliberately leaves underwriting off-chain** ("underwriting and risk management happen off-chain"; no on-chain
   collateral or liquidation [SPEC66]). The ledger executes the loan; it does not decide it. **ChainAim is that missing
   decision layer**: the CFO's books stay on their PC, the numbers come from ACTUS (deterministic), the AI only translates
   language in and explanations out, and every call is paid in RLUSD.
2. **Pitch line:** *On-chain execution, off-chain judgment — ChainAim makes the judgment private, exact and checkable.*
3. **Liquidity to use = depositor confidence.** XLS-65 vault depositors fund loans they cannot see underwritten. Giving
   brokers and depositors an ACTUS view of the vault's loan book (expected cash flows, default and first-loss-cover
   scenarios) is what lets idle liquidity be lent.
4. **No C++.** Everything is TypeScript on top of what exists: xrpl.js 5.3.0 has all `Vault*` and `Loan*` transactions
   [SDK]; ACTUS and the analyst already run [CODE]. Amendments are network-side; we only pick a network where they are on.

---

## 1. What XLS-65/66 are trying to do (verified, condensed)

| Fact | Source |
|---|---|
| Uncollateralised, fixed-term loans funded by a pooled single-asset vault; underwriting off-chain | [SPEC66] |
| Roles: Vault owner = Loan Broker (same account for now); Borrower; Depositors | [SPEC66, SPEC65] |
| `LoanSet` needs both borrower and broker signatures (`CounterpartySignature`) | [SPEC66] |
| Terms: `PrincipalRequested`, `InterestRate` / `LateInterestRate` / `CloseInterestRate` / `OverpaymentInterestRate` (1/10 bp), `PaymentTotal`, `PaymentInterval` (s, ≥60), `GracePeriod`, origination/service/late/close fees, `Data` | [SPEC66, SDK LoanSet] |
| Fixed periodic payments; **stored ledger values are authoritative** (formulas in Appendix A-3, not read) | [SPEC66] |
| First-loss capital (cover) on the LoanBroker: `CoverRateMinimum`, `CoverRateLiquidation`; below minimum → no new loans | [SPEC66] |
| Impairment (`LoanManage`) books `LossUnrealized` on the vault, so early redeemers can't dodge a known loss; default → cover absorbs part, rest written off | [SPEC66, SPEC65] |
| Private vaults gate deposits with Credentials (XLS-70) in a Permissioned Domain (XLS-80) | [SPEC65] |
| V1.1: closed-ended vaults; `LoanSet` only in the Investment phase, maturity + buffer before `RedemptionDate` | [SPEC66] |
| **Status:** specs Draft; xrpld 3.4.0 (2026-09-16) ships LendingProtocolV1_1, default vote No; mainnet **not enabled**; 2026-09-17 snapshot SingleAssetVault 16/35, LendingProtocol 13/35 validators | [NEWS] |

Network: earlier chat planned lending on **Devnet** ("only place it's enabled") and payments on Testnet [CHAT xplh-3].
[ASSUME] still true — check with the `feature` RPC on Devnet before building (blocked from this session's network today).

So this is **traditional private credit with on-chain settlement**, not ETH-style over-collateralised DeFi. The judges' question
is "how do real lenders decide, safely and repeatably?" — that is our ground.

---

## 2. Highlights beyond yield (the convincing arguments)

| # | Highlight | Who it serves | Why it is strong for XLS-66 |
|---|---|---|---|
| H1 | **Borrower readiness from own books, privately** — "Can we afford 50k RLUSD over 12 months at 9%?" answered from the CFO's own ledgers; books never leave the PC | Borrower (SME CFO) | XLS-66 assumes off-chain underwriting; this makes it private by construction |
| H2 | **Terms ↔ ledger translator** — plain-language terms → ACTUS ANN/PAM → XLS-66 fields (1/10 bp, seconds, payment count) → **draft unsigned `LoanSet`** | Borrower + Broker | Removes unit errors (bp vs 1/10 bp, months vs seconds) before a co-signed, irreversible tx |
| H3 | **Underwriting attestation in `Data`** — hash of the underwriting pack + verdict in `LoanSet.Data` | Broker, auditors, depositors | Broker sees verdict and hash, not the books; anyone can later prove which analysis backed the loan |
| H4 | **Schedule reconciliation** — ACTUS schedule vs the ledger's `Loan` object (`PeriodicPayment`, `NextPaymentDueDate`, `PaymentRemaining`) | Broker, Borrower | Ledger is authoritative [SPEC66]; ACTUS independently confirms it — deterministic cross-check, flags rounding/term drift |
| H5 | **Depositor / vault risk view** — ACTUS run of the whole loan book: expected inflows, rate shock, late and default scenarios, cover adequacy vs `CoverRateMinimum`, effect on share value via `LossUnrealized` | Depositors, Broker | Directly serves "put XRPL liquidity to use": depositors deposit when they can see the downside |
| H6 | **Servicing decisions, human-signed** — late payment → ACTUS impact → recommend impair / wait / default; broker signs `LoanManage` | Broker | AI recommends, deterministic numbers justify, human signs: the right split for credit |
| H7 | **Who may lend / borrow** — private vault + Credentials (XLS-70/80); LEI/vLEI check of borrower (links to xrplh-11 §vLEI) | Compliance | Institutional KYB on the deposit side, without our own contracts |

Recommended hackathon scope: **H1 + H2 + H3 + H4** (one borrower, one loan, live on Devnet), H5 as a single depositor screen,
H6/H7 on the roadmap slide.

---

## 3. Deterministic vs AI — where each is used

| Step | Deterministic (exact, repeatable) | AI (language, judgment support) |
|---|---|---|
| Read the CFO's question | — | Intent + terms extraction (existing `parseTerms` in actus.ts, **checked against the document's own text** [CODE]) |
| Business data | DuckDB cross-file queries, flows, mismatches, evidence pack (services/analyst) [CODE] | Chooses which question to ask of the data |
| Cash flows | ACTUS PAM/ANN schedules, scenarios [CODE actus.ts] | — |
| Affordability | Rules on numbers: DSCR-style coverage, cash buffer, worst-scenario shortfall (config thresholds) | Explains the verdict in plain words |
| XLS-66 fields | Pure conversion functions + validation (ranges, ≥60 s, grace ≤ interval) | — |
| Explanation | `/verify` flags any number in the model's answer not in the evidence [CODE analyst] | Narrative for CFO / broker |
| Decision | Broker and borrower **sign** | Never signs |

Rule carried from xrplh-3: *numbers are computed, the model only explains them.*

---

## 4. Conceptual flow (H1–H4)

```
CFO PC (private)                     ChainAim (paid per call, RLUSD)            XRPL Devnet (lending)
────────────────                     ──────────────────────────────             ─────────────────────
1 "Can we take 50k over 12m at 9%?"
2 analyst: ledgers → monthly net cash (DuckDB, exact)
3 mask identities; send amounts+dates ──▶ 4 ACTUS ANN: schedule; scenarios
                                           (base, +200 bp, receivables +30 d)
                                         5 affordability rules → verdict
                                         6 model explains (verify-checked)
                                         7 terms → XLS-66 fields; draft LoanSet,
                                           Data = hash(underwriting pack)+verdict
8 restore names locally; CFO reviews ◀──
9 borrower signs ──▶ broker reviews verdict+hash, counter-signs ──▶ LoanSet ──▶ Loan object
10 ChainAim reads Loan (xrpl.js) and reconciles with ACTUS schedule  ◀──────── ledger values
11 (H5) depositor screen: vault + broker objects → ACTUS book run → cover / loss view
```

Payments for steps 4–7: existing x402 RLUSD on Testnet (or the AP4M voucher rail from xrplh-11 — the same "agent pays for
underwriting within a cap" story serves both tracks).

---

## 5. What fits where (codebases and SDKs)

| Part | Where | Status |
|---|---|---|
| CFO data queries (cross-file, flows, evidence, verify) | `services/analyst` (DuckDB) | **exists** [CODE] |
| ACTUS PAM/ANN, terms from documents, checks | `services/analyst/src/actus.ts` + ACTUS server / ACTUS Mentor | **exists** (PAM, ANN only) [CODE] |
| Masking, model routing, paid gateway | `services/gateway`, `services/paywall` | **exists** |
| Strands agent that asks / pays | `services/paywall/scripts/agent*.ts` | **exists** (one tool today) |
| XLS-66 mapping + draft `LoanSet` + read `Loan`/`LoanBroker`/`Vault` | new `packages/xls66` (pure TS, xrpl.js **5.3.0**) | new; note repo pins xrpl **4.7.0** → upgrade needed [ASSUME 4.7.0 lacks Loan types — check] |
| Affordability rules + thresholds | new `packages/underwrite` (pure TS) + `config/underwriting.json` | new |
| Devnet scripts: vault, broker, cover, loan co-sign, pay | `services/paywall/scripts/lending/*.ts` (same CLI/flag style as trust-line.ts) | new |
| rippled / C++ | none | not needed |

Flags (sketch, all with defaults): `--network devnet`, `--vault-id`, `--loan-broker-id`, `--scenarios base,rate+200,late30`,
`--min-coverage 1.25`, `--cash-buffer-months 2`, `--draft-only` (default on; never submits without both signatures).

Extra Strands tools (one agent, three tools): `chainaim_private_ask` (exists), `underwrite_loan(terms, folder)`,
`reconcile_loan(loanId)`. Same masking, same spending ceiling.

---

## 6. 3-minute demo

| t | Show |
|---|---|
| 0:00 | Problem: XLS-66 lends without collateral; lenders must underwrite off-chain — today that means emailing books |
| 0:20 | CFO asks in plain English; analyst computes monthly cash from their own CSV ledgers (nothing leaves) |
| 0:50 | ACTUS schedule + 3 scenarios; verdict "affordable, worst-month cover 1.4x"; explanation verified against numbers |
| 1:30 | Draft `LoanSet` with fields in XLS-66 units and `Data` = attestation hash; borrower signs, broker counter-signs (Devnet) |
| 2:10 | Ledger `Loan` object vs ACTUS schedule: match |
| 2:30 | Depositor view: vault book, default scenario, cover absorbs X, share value impact |
| 2:50 | Each step was paid in RLUSD by the agent within its cap |

---

## 7. Risks / checks before building

1. Devnet has LendingProtocol + SingleAssetVault enabled (the `feature` RPC) — and whether V1.1 (closed-ended vault,
   Investment phase) is active there, which changes the setup order.
2. ACTUS ANN payment vs XLS-66 `PeriodicPayment` rounding (Appendix A-3 not read): H4 must report differences, not assume equality.
3. Lending asset on Devnet: XRP or a test IOU; RLUSD on Devnet unverified [CHAT xplh-3 flagged the same].
4. `Data` is a hex string; 256-byte limit from the earlier chat [CHAT xplh-3] — confirm in the spec before fixing the format.
5. Only PAM/ANN exist in actus.ts; XLS-66 loans are fixed-rate amortising, so ANN covers the main case.

Open questions: (1) H5 in scope or roadmap? (2) Pay for underwriting via x402 (L1) or AP4M voucher? (3) Thresholds for the verdict.

---

## 8. Verified against the specs and live ledgers (added 2026-10-24 19:30 UTC-05:00)

Sources: raw `XLS-0066-lending-protocol/README.md` (2,710 lines, header `status: Draft`, `updated: 2026-09-15`) and
`XLS-0065-single-asset-vault/README.md` (1,296 lines, `status: Draft`, `updated: 2026-09-15`) from XRPLF/XRPL-Standards master;
xrpl.org Lending Protocol concept page; live `feature` RPC; npm xrpl@5.3.0 types. § numbers below are spec section numbers.

### 8.1 Claims checked

| Claim | Verdict | Evidence |
|---|---|---|
| Uncollateralised, fixed-term, pooled funds | **Confirmed** | XLS-66 §1 Abstract; xrpl.org concept page |
| Underwriting off-chain | **Confirmed** | XLS-66 §1: design "relies on off-chain underwriting and risk management"; xrpl.org same |
| No on-chain collateral / liquidation (deliberate) | **Confirmed** | XLS-66 §1: "intentionally skips" automated collateral and liquidation |
| First-loss capital held by broker, % of debt, partly liquidated into vault on default | **Confirmed** | XLS-66 §2.2, §3.1.11; LoanBroker fields `CoverAvailable`, `CoverRateMinimum`, `CoverRateLiquidation` (§3.1.2) |
| LoanSet signed by both borrower and broker | **Confirmed** | XLS-66 §3.8.3 "must be signed by both parties"; §3.8.1.1 `CounterpartySignature` |
| Impairment books a paper loss on the vault (`Vault.LossUnrealized`) | **Confirmed** | XLS-66 §3.2.10; XLS-65 §3.1.2 `LossUnrealized` |
| Impair only once overdue; default only after grace period | **Confirmed, amendment-dependent** | XLS-66 §3.10 failure conditions (fixCleanup3_4_0: impair needs time > NextPaymentDueDate; default needs time > NextPaymentDueDate + GracePeriod) |
| `Data` on LoanSet, hex, ≤256 bytes | **Confirmed** | XLS-66 §3.8.1 field table; xrpl.js 5.3.0 `LoanSet.Data?: string` |
| Specs are Draft | **Confirmed** | both headers `status: Draft` |
| Not enabled on mainnet | **Confirmed live** | `feature` RPC via xrplcluster.com and xrpl.ws: `LendingProtocol`, `LendingProtocolV1_1`, `SingleAssetVault` → supported, **enabled=false**; `Credentials`, `PermissionedDomains`, `MPTokensV1` → **enabled=true** |
| Not enabled on Testnet | **Confirmed live** | `feature` via testnet.xrpl-labs.com: LendingProtocol, SingleAssetVault, LendingProtocolV1_1, fixCleanup3_4_0 all enabled=false |
| Enabled on Devnet | **Confirmed live (owner run, 2026-10-24 19:34 UTC-05:00)** | `feature` on s.devnet.rippletest.net:51234: `LendingProtocol`, `LendingProtocolV1_1`, `SingleAssetVault`, `fixCleanup3_4_0`, `Credentials`, `PermissionedDomains`, `MPTokensV1` all **enabled=true** |
| xrpld 3.4.0, 2026-09-16, LendingProtocolV1_1 default vote No | **Secondary source only** | crypto.news article; not checked against GitHub release notes |
| 13/35 validators for LendingProtocol (2026-09-17) | **Secondary source only** | crypto.news citing an independent tracker; public `feature` RPC does not show vote counts. Do not put on a slide. |

### 8.2 Interface points and data (where ChainAim touches the ledger)

| # | Interface | Direction | Data (exact field names, units) | Spec |
|---|---|---|---|---|
| I1 | CFO books → analyst | off-chain, PC only | CSV/TSV ledgers → monthly net cash, flows, mismatches (DuckDB) | [CODE services/analyst] |
| I2 | Terms → ACTUS | off-chain | `Terms{contractType PAM/ANN, notional, annualRate, startDate, termMonths, dayCount}` | [CODE actus.ts] |
| I3 | ACTUS/terms → **`LoanSet`** (draft) | write (co-signed) | `LoanBrokerID`, `PrincipalRequested` (NUMBER string), `InterestRate` / `LateInterestRate` / `CloseInterestRate` / `OverpaymentInterestRate` (UINT32, **1/10 bp**, 0–100000), `PaymentTotal` (default 1), `PaymentInterval` (**seconds**, default 60), `GracePeriod` (seconds, default 60), `LoanOriginationFee` / `LoanServiceFee` / `LatePaymentFee` / `ClosePaymentFee`, `OverpaymentFee`, `Flags` (`tfLoanOverpayment` 0x00010000), `Counterparty`, `CounterpartySignature{SigningPubKey,TxnSignature | Signers}`, **`Data` (hex ≤256 B) = attestation hash + verdict** | XLS-66 §3.8 |
| I4 | Broker policy → `LoanBrokerSet` | write (broker) | `VaultID`, `ManagementFeeRate`, `DebtMaximum`, `CoverRateMinimum`, `CoverRateLiquidation`, `Data` | XLS-66 §3.3; xrpl.js |
| I5 | Vault setup → `VaultCreate` | write (broker) | `Asset`, `tfVaultPrivate` + `DomainID` (Permissioned Domain → credentialed depositors), `tfVaultShareNonTransferable`; under V1.1 `VaultKind` closed-ended with `SubscriptionDate`, `RedemptionDate` | XLS-65 §2.5, §3.2 |
| I6 | Ledger → reconciliation (H4) | read | `Loan`: `PeriodicPayment`, `NextPaymentDueDate`, `PreviousPaymentDueDate`, `PaymentRemaining`, `PrincipalOutstanding`, `TotalValueOutstanding`, `ManagementFeeOutstanding`, `StartDate`, `PaymentInterval`, `GracePeriod`, `LoanScale`, `Flags` | XLS-66 §3.2.2 |
| I7 | Ledger → depositor view (H5) | read | `LoanBroker`: `DebtTotal`, `DebtMaximum`, `CoverAvailable`, `CoverRateMinimum`, `CoverRateLiquidation`; `Vault`: `AssetsTotal`, `AssetsAvailable`, `LossUnrealized`, `ShareMPTID`; RPC `vault_info` | XLS-66 §3.1.2; XLS-65 §3.1.2, §3.9 |
| I8 | Servicing advice → `LoanManage` | write (broker signs) | `tfLoanImpair` 0x00020000 / `tfLoanUnimpair` 0x00040000 / `tfLoanDefault` 0x00010000 (mutually exclusive), timing rules above, impair limited by vault unavailable assets (`tecLIMIT_EXCEEDED`) | XLS-66 §3.10 |
| I9 | Borrower repayment → `LoanPay` | write (borrower) | `tfLoanLatePayment` / `tfLoanFullPayment` / `tfLoanOverpayment`; late payment without flag → `tecEXPIRED` | XLS-66 §3.11 |
| I10 | ChainAim fee | write (payment) | RLUSD per call: x402 on XRPL Testnet (today) or AP4M voucher (xrplh-11) | [CODE paywall] |

[ASSUME] Ledger time fields (`StartDate`, `NextPaymentDueDate`) use XRPL's standard seconds-since-2000 epoch — check one Devnet `Loan` before converting dates.

### 8.3 Consequence: Devnet runs the V1.1 + fixCleanup3_4_0 rules (confirmed enabled)

1. A new `LoanBroker` needs a **closed-ended** vault (XLS-66 §2.7 → 66.1.2): `VaultCreate` with `VaultKind` closed-ended,
   `SubscriptionDate`, `RedemptionDate` (XLS-65 §2.5).
2. `LoanSet` only in the **Investment** phase (after `SubscriptionDate`, before `RedemptionDate`), and the loan's final payment
   plus a buffer must fall before `RedemptionDate`. [CHECK] the buffer value in 66.1.2 before choosing dates.
3. Demo setup order: create closed-ended vault (subscription window of a few minutes) → depositor deposits → broker
   `LoanBrokerSet` + cover deposit → wait for SubscriptionDate → co-signed `LoanSet` with a short schedule
   (e.g. `PaymentInterval` 300 s, `PaymentTotal` 3) → `LoanPay` x3 → reconcile. Redemption date after the last payment + buffer.
4. Servicing: impair only when overdue, default only after `NextPaymentDueDate + GracePeriod` (boundaries exclusive).
