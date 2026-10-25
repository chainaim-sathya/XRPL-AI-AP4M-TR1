# ChainAim — design plan, reconciled (xplh-3 + plan v3 + codebase)

**Written:** 2026-10-23 16:03 IST. Read-only review: no code was changed.
**Replaces for planning purposes:** `xplh-3-DESIGN-PLAN-2026-10-23.md` (chat output, stopped at message 49) — that one missed plan v3.

## 0. Sources and limits

| Source | How it was used |
|---|---|
| xplh-3 chat (`claude.ai/chat/8db26b31-…`) | **Full read is blocked** ("content redacted, flagged by safety classifier"). Its **search snippets are still readable**; plan v3, the layered deliverables and the session log were recovered from those snippets. Only fragments were returned, not whole files. |
| `DESIGN/xrplh-3-FULL-SESSION-2026-10-23T1516.md` | Read in full (53 messages, 12 corrections). |
| Earlier full analysis (`xplh-3-FULL-ANALYSIS-2026-10-23.md`, chat "xplh -implementation-L0") | Read; covered all 98 turns up to message 49. |
| Repo code | Read 2026-10-23 (see the companion file `…_codebase-review-and-iteration-plan.md`). |
| `FINAGENTS\DESIGN\xrplh-3-HACKATHON-PLAN-v3-2026-10-23T0312.md` | **Not on this PC.** The plan was written there from a UTC-05:00 session; the path does not exist here. Contents below come from search snippets of the chat, tagged `[V3]`. |

**Tags:** `[V3]` plan v3 or the layered deliverables (from chat snippets) · `[SESSION]` session record file · `[CODE]` repo · `[CHECK]` unverified · `[GAP]` named in the sources but details not recovered.

---

## 1. Story and rule

- **Story [V3]:** Jupiter's finance agent asks its own books questions privately (**channel A**). It pays per answer in RLUSD, but only when the answer can be computed privately and within limits its CFO signed. A large Tommy Hilfiger order needs working capital. A lender then gets **verified, signed answers** about Jupiter's books (**channel B**), partly checked against Jupiter's own RLUSD payments on XRPL. The loan is created with XRPL's Lending Protocol, with fingerprints of that evidence inside.
- **Rule:** **No private path → no payment.**
- **Tagline:** *Ask your books anything. Show nobody your books.* [V3]

## 2. Cast and keys

| Who | Role | Keys [V3] |
|---|---|---|
| Jupiter Knitting | SME, ChainAim user, borrower | agent wallet (Testnet), revenue wallet (Testnet), officer key (KMS P-256), borrower account (Devnet) |
| 2 other tenants | Other ChainAim buyers | agent wallets |
| Kestrel Trade Finance *(provisional)* | Lender, vault owner, loan broker; buys the credit-check ticket | broker account (Devnet) |
| Harbor Capital *(provisional)* | Investor, vault depositor | Devnet account |
| ChainAim | Router + payment rails + independent checker. **Never approves a customer's spending.** | payTo wallet (Testnet), attestation key (KMS) |
| ACTUS | Cash-flow calculator from loan terms only | — |

**Configuration:**
- Names are settings, kept in `config/demo-cast.json` [V3]. This file **does not exist in the repo yet** [CODE].
- In the repo, tenant t01 is "Jupiter Knitting (synthetic test tenant)" [CODE `rig/tenants/t01/tenant.json`].

**Caution [V3]:**
- Jupiter Knitting is a real company. Using its name or LEI next to generated figures needs its consent; otherwise mark it "(demo)" or use a made-up name.
- Earlier chats contain **two different LEIs** for it. Verify with GLEIF before using either.

## 3. The two channels

| | Channel A — private AI | Channel B — verified disclosure |
|---|---|---|
| Who asks | Jupiter's agent | Kestrel (lender), Harbor (investor) |
| What crosses | Minimum masked context | Signed, verified metrics; never masked text |
| Do AI models touch the numbers? | Yes, masked | **No.** Numbers are computed or proven; AI only explains them |
| Paid by | Jupiter (x402 RLUSD per call) | Kestrel (credit-check ticket, recovered via `LoanOriginationFee`) |
| Routes [SESSION/T95] | `/v1/private/*` | `/v1/disclose/*` |

---

## 4. Deliverable layers (plan naming) [V3]

| Layer | Delivers | Hours |
|---|---|---|
| **L0 Rigs** | Connectivity and latency tests R1–R12, each PASS/FAIL to a log, run before the event | 3–4 |
| **L1 Many buyers, private AI** | 3 tenants; generated test data and canary records; client pipeline: read folder → pre-flight → T0 local → minimum context → mask → leak gate → signed header → pay → send → server rescan → model → restore → verify. Channel-A ACTUS what-if computed locally. | 3 |
| **L2 Intents, limits, escalations** | Mandates signed by officer keys (KMS P-256); running total; one use per slip. Cost escalations happen at the paywall; privacy escalations happen on the client, with nothing sent. Agents carry on: the escalated item is parked and **expires in 30 min**. | 2–3 |
| **L3 Screens** | Agent terminal lines · Jupiter's CFO console (approvals inbox: **Approve once / Raise limit / Deny**, signed with the officer key) · ChainAim control room (§6) | 2–3 |
| **L4 AWS** | Bedrock models (masked text only) · KMS keys · Strands agent: **Pattern A** (agent plus Ollama on Jupiter's computer) or **Pattern B** (brain on Bedrock, sees masked text only) | 2 |
| **L5 Lending (channel B)** | See below | 3–4 |
| **L6 Stretch** | Enclave-signed attestation (hello-enclave rig first) · ZK: ZK-PRET GLEIF "active legal entity" proof (needs a verified LEI) or a coverage proof · vault stress · Ledger device | as time allows |

**L5 steps:**
1. Customer wallets pay Jupiter's revenue wallet.
2. Kestrel buys a ticket.
3. The checker builds the ACTUS schedule from the terms, adds ledger-verified income and runs the scenarios.
4. Jupiter's CFO signs the submission.
5. ChainAim signs the attestation.
6. On Devnet: vault → broker → cover → Harbor deposits → LoanSet with `Data` → LoanPay.
7. Invoices can be checked on request.

**Time plan [V3]:**

| Path | Layers | Hours |
|---|---|---|
| Core (must) | L0 + L1 + L2 + L3 | ~8 |
| AWS | L4 | ~2 |
| Lending | L5 | ~3–4 |
| Stretch | L6 | as time allows |

- **Minimum:** L1–L3. **Strong entry:** add L4 and L5.
- **Split with 2–3 people:** P1 = L1 client pipeline; P2 = L2 paywall + L3 UI; P3 = L5 Devnet + ACTUS + attestation; L4 shared.

### ⚠ Layer-name clash with the repo
The repo's `STATE.md` uses the **older** layer numbering from the KMS/VI build plan [SESSION T21]:
- **L0** = signer-based payments + rig
- **L1** = Strands agents
- **L2** = KMS Ed25519 signer

| Repo says | Plan v3 equivalent |
|---|---|
| repo **L0** done (3 tenants, 30/30 settled) | **R1 PASS** + the "3 tenants paying" part of plan **L1** |
| repo **L1** partial (Strands agent on Bedrock, Pattern B) | Part of plan **L4** (Strands) + the "read folder → mask → pay" part of plan **L1** |
| repo **L2** next (KMS Ed25519 signer) | Part of plan **L4** (KMS keys) |

**Recommendation:** use the plan v3 names (L0–L6) from now on, and record this mapping in `STATE.md`.

---

## 5. Connectivity rigs (plan L0) [V3]

**Rule:** a layer is built only on rigs that passed. A failed rig moves its feature to the roadmap slide.

| # | Rig | Pass when | Status (from code / logs) |
|---|---|---|---|
| R1 | XRPL Testnet x402 | Faucet → RLUSD trust line → one paid call settles | **PASS** (tx `E55B…400A`; then 30/30 on 2026-10-23) [CODE/LOG] |
| R2 | Quicknode XRPL Testnet | A WebSocket subscription sees a payment to a test address; `account_tx` returns it | Not started; needs your endpoint |
| R3 | Devnet lending | xrpl.org `lendingSetup.js` → loan broker → cover → LoanSet with `Data` validates; note the vault type (closed-ended?) and asset | Not started |
| R4 | ACTUS | `/eventsBatch` ANN returns IED/PR/IP locally (Docker) and on the hosted endpoint; schedule matches XRPL `PeriodicPayment` | Not started; ports must be closed first |
| R5 | Bedrock | Converse call to Nemotron 3 Nano in us-east-1 returns usage tokens | Not run. Note: the repo's agent defaults to `global.anthropic.claude-sonnet-4-6` [CODE `agent.ts`] |
| R6 | KMS | Create a P-256 key, sign, verify locally (DER → JWS) | Not started |
| R7 | Strands + Ollama | 10 questions, tool called each time, latency recorded | Not possible yet: `agent.ts` supports Bedrock only [CODE] |
| R8 | Local classifier | Transformers.js NLI model loads offline; latency recorded | Not started |
| R9 | Presidio isolation | Outbound from Presidio fails; gateway health OK | Not started |
| R10 | Enclave hello (stretch) | EC2 enclave returns an attestation document; laptop verifies it to the AWS root | Not started |
| R11 | ZK-PRET (stretch) | Existing GLEIF proof runs for a verified LEI; proof verifies; times recorded | Not started |
| R12 | Latency matrix | Rows 1/10/50/200 × models (Gemma 3 4B, Nemotron 3 Nano, local Qwen) × payment on/off. Pick settings where p95 < ~10 s; 30 s timeout; progress indicator | Not started |

---

## 6. Screens (plan L3) [V3]

**ChainAim control room:**
1. **Seller wallet meter (live):** ChainAim's payTo wallet via Quicknode: balance, incoming RLUSD per tenant, payments per minute.
2. **Where masked data went:** for each paid call, the destination (local model, Bedrock model or OpenRouter provider), the provider's data policy (no collection, zero retention), a "masked only" badge, estimated provider cost and margin, plus totals per destination. Bedrock is billed to the AWS account, not paid on XRPL, so it shows as an estimated cost.
3. **Refusals as helpful cards:** what happened · why · next step · RLUSD saved · "no transaction = no charge".
4. **Escalation status only:** ChainAim never approves a customer's spending.
5. **Proof:**
   - a masked sample
   - canary results: planted / blocked by client / caught by server / reached a model
   - numbers verified
   - signed privacy receipts
6. **Lane B:** tickets, attestations, LoanSet links.

**CFO console:** approvals inbox with Approve once / Raise limit / Deny, signed with the officer key.
**Agent terminal:** one line per tool call. The repo already prints `[chainaim_private_ask] file: status, amount, tx` [CODE `agent.ts`].

## 7. Three attestations [V3]

| Name | Signed by | Proves | Layer |
|---|---|---|---|
| Privacy receipt (per paid call) | ChainAim | Counts, route, price, tx; no text | L3 |
| Credit-check attestation | ChainAim, plus Jupiter's signed submission | Verdict from the stated sources; ledger-verified share | L5 |
| Enclave attestation | AWS Nitro hardware | Which code produced the verdict; that operators couldn't read the data | L6 stretch |

## 8. How fake books are caught [V3]

- **The check:** ChainAim reads XRPL itself via Quicknode. Jupiter's revenue wallet (listed in its signed company profile) should have received RLUSD payments matching its paid invoices: same amount, within the date window, with memo = invoice number.
- **The measure:** `ledger_verified_share` = ledger-confirmed inflows ÷ claimed inflows. Bank-file inflows count as self-provided.
- **Example lender rule:** below 50% → "insufficient evidence".
- **Demo:** honest data → approved; inflated invoices → "insufficient evidence".
- **Principle:** fake books are caught by the **sources**, not by signatures. A signature means "computed correctly", not "the data is true".

---

## 9. The loan [V3]

### Purpose and terms
- **Purpose:** purchase-order (working-capital) finance. Jupiter must buy yarn and pay workers months before Tommy Hilfiger pays.
- **Shape:** e.g. **50,000 RLUSD for 90 days**. Two options (**your decision**):
  - **Bullet:** `PaymentTotal` 1, interval 90 days, ACTUS PAM.
  - **3 monthly payments:** `PaymentTotal` 3, interval 30 days, ACTUS ANN.
- **Fixed rate:** set at signing and never changes. `InterestRate` is annual, in 1/10 basis points. Short trade loans are commonly fixed in traditional finance too.
- **Scenarios (income side, because the rate is fixed):**
  - as planned
  - income −20%
  - the buyer pays 30 days late
  - the largest customer doesn't pay

### XLS-65/66 intent vs DeFi
- **How the protocol works:**
  - Depositors put one asset into a vault and receive shares.
  - A broker lends on fixed terms and keeps first-loss cover.
  - Credit decisions stay **off the ledger**.
- **Who is using it:**
  - Soil: an RLUSD Single Asset Vault for institutional lending.
  - Evernorth: fixed-term, fixed-rate XRP loans.
- **Our role:** the private, checkable credit decision that the protocol leaves off the ledger.
- **Unlike typical DeFi:** no collateral and **no liquidation**; known borrowers; fixed rates.

### Price risk
- **RLUSD vault (our demo):** the XRP price doesn't matter. If RLUSD de-pegged, depositors would bear the dollar loss; the borrower still owes the same number of RLUSD.
- **XRP vault:** the debt is owed in XRP; still no liquidation.

### If the borrower doesn't pay
1. A grace period runs (between 60 s and the payment interval).
2. `LatePaymentFee` and `LateInterestRate` apply.
3. The broker marks the loan impaired, then defaulted (`LoanManage`).
4. First-loss cover pays a limited share (spec example: 10.9 of a 1,090 default with 1,000 cover); depositors absorb the rest.
5. Recovery continues off the ledger under the loan agreement.

Monthly channel-B covenant checks give the early warning before step 1.

### ACTUS [V3; correction 12]
- **Input:** loan terms only, no private data.
- **Call:** `POST /eventsBatch` with a PAM or ANN contract. No external risk service.
- **Where it runs:** local Docker for development; hosted behind the gateway for the demo, with no public ports.
- **Coverage** = income ÷ payment, per period and per scenario.
- **R4 must settle:** XRPL's payment interval is in seconds (30 days); ACTUS's `P1ML0` is a calendar month.

---

## 10. Sending rows, and latency [V3]

| Question type | What gets sent |
|---|---|
| Totals and rankings | Totals per group, from DuckDB |
| A draft for each item | **One** masked template built from 1–3 example rows, filled in locally for every item. **One payment, not one per item.** |
| Unusual items | Local rules pick candidates; up to 20 masked rows are sent |
| Explaining a total | The total, plus the few rows behind it |

**Limits (verified in code):** the gateway accepts 48,000 chat characters and 512 text fields per request [CODE `chat.ts`]. Flatten everything into one message.

**Starting values to tune:** 50 rows, 12,000 characters, 400 words of output.

**[CHECK]:** how long a quoted x402 price stays payable. The code default is `XRPL_MAX_TIMEOUT_SECONDS` = 600 [CODE/MANUAL_SETUP].

---

## 11. Privacy pipeline and spend control (unchanged from the earlier design)

**Privacy pipeline:**
- Laptop by default; the company server is optional.
- Local classifiers run **before** masking; remote ones (Jev) only on masked text. Jev is skipped for any class that forbids outside classifiers.
- The `X-ChainAim-Preflight` header means "stricter, never looser".
- `--on-server-detect mask|refuse|upgrade`; `refuse` means no charge.
- Data classes: PHI/PCI/PII/FIN/CONF/SECRET + jurisdiction + `policy.yaml`. The code has only `PHI|PCI|PII|none` today [CODE].

**Spend control:**
- VI-shaped mandates (ES256, KMS P-256); one use per L3 slip.
- A server-side running total.
- Timeout → **PENDING**, with the budget kept reserved.
- Revocation via `CredentialDelete`.
- **VI never covers debt.**
- Claim "VI-shaped", not Mastercard-certified [V3].

**On-ledger link:**
- LoanSet `Data` (≤ 256 bytes) = version | result hash | submission hash | verdict | source level.
- Never `InvoiceID`: x402 already uses it [CODE `xrpl-payment.ts`, SESSION corr. 3].

---

## 12. What the code shows vs this plan (summary)

**Already in the code:**
- R1 passed.
- 3 tenants pay through the `XrplSigner` interface, with a client ceiling.
- The client masker, self-check and placeholder restore.
- A Strands agent (Bedrock) with one file-scoped tool.
- The gateway pipeline (Presidio, classes, Jev, free-model chain, restore).
- The analyst (DuckDB; `/evidence`, `/verify`).
- Invoice replay protection.

**Not in the code yet:**
- **Pipeline and safeguards:** pre-flight / T0 tier, minimum-context shaping, the signed header, canary records, the server-side mandate and escalation, `demo-cast.json`.
- **Screens and AWS:** the screens, Ollama Pattern A, the KMS signer.
- **Lending and stretch:** Quicknode, Devnet lending, ACTUS, channel B, attestations, L6.

**Gaps the plan assumed were closed:**
1. The agent's typed prompt reaches Bedrock **unmasked** [CODE `agent-core.ts` comment]. Pattern B requires masked text only.
2. The paywall enforces **no** per-payer limit [CODE `app.ts`].
3. The paywall forwards only `authorization` and `content-type`, so the preflight header would be dropped [CODE `app.ts`].
4. Secrets are in `.env.example`, which `.gitignore` explicitly includes (`!.env.example`) [CODE].

## 13. Corrections that bind the build (merged list)
1. All 13.5M agentic payments settled; ≈ $21.6K is their total value.
2. A timeout stays pending; the budget is never released on timeout.
3. x402 already uses `InvoiceID`; link evidence via Memo or off-chain.
4. Jev is TypeSafe AI's model, reached through OpenRouter.
5. Skip Jev for every class whose policy forbids outside classifiers.
6. DeBERTa NLI is the Node default; GLiClass needs a Python sidecar.
7. The company server is optional.
8. Today's deployment does not yet keep raw data off the gateway.
9. Either party may sign LoanSet first; `InterestRate` is annual.
10. The lender gets verified disclosure, not masked data.
11. XRPL loans are fixed-rate, so scenarios are income-based.
12. ACTUS needs loan terms only: no private data, no external risk service.
13. Canary claim: "none reached a model; the server caught the rest". Do not say "0 reached ChainAim".

## 14. Open decisions and checks
- **Decisions for you:**
  - Bullet vs 3 monthly payments.
  - Real vs fictional borrower name (consent; verify the LEI).
  - Lender and investor names.
  - Adopt the plan v3 layer names in `STATE.md`.
- **Manual checks:**
  - Rotate the leaked keys.
  - `node`/`docker`/`ollama` versions on the demo PC.
  - ACTUS security-group rules.
  - Bedrock (Nemotron 3 Nano and Claude Sonnet 4.6) and KMS access in us-east-1.
  - A Quicknode Testnet endpoint.
  - Ask the organizers whether one project can enter both tracks.
- **Not recovered from the chat** `[GAP]`:
  - plan v3's full text beyond the sections quoted here
  - the 8 demo queries
  - the five data-source levels
  - the exact `tenant.json` additions

  Copy plan v3 from the other machine into this folder to close these.
