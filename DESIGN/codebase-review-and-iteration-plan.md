# Codebase review and iteration plan (keyed to plan v3 layers)

**Written:** 2026-10-23 16:03 IST. Read-only review; no code was changed.
**Companion:** `2026-10-23T1603+0530_xplh-3-DESIGN-PLAN-reconciled.md`. That file has the design, the layer names (L0–L6, rigs R1–R12) and the repo-name mapping.

**Tags:** `[CODE]` read in the file named · `[LOG]` STATE.md / BUILD_LOG.md · `[CHECK]` unverified, check before coding.
I did not run any tests (no shell on this PC); the counts come from BUILD_LOG.md.

---

## 1. Files read

**Read in full:**
- **Project files:** `PROJECT_CONTEXT.md`, `STATE.md`, `CLAUDE.md`, `.gitignore`, `.env.example`, `package.json`, `rig/README.md`
- **Paywall scripts** (`services/paywall/scripts/`): `agent-core.ts`, `agent.ts`, `private-ask-core.ts`, `signer.ts`, `xrpl.ts`, `rig-core.ts`, `client-mask.ts`
- **Paywall service** (`services/paywall/`): `src/routes.ts`, `src/app.ts`, `src/invoices.ts`, `package.json`
- **Gateway** (`services/gateway/src/`): `main.ts`, `chat.ts`, `routing/select.ts`, `privacy/classify.ts`
- **Analyst:** `services/analyst/src/main.ts`
- **Rig tenant t01:** `rig/tenants/t01/tenant.json`, `rig/tenants/t01/queries.json`
- **Owner records:** the latest sections of `MANUAL_SETUP.md` and `BUILD_LOG.md`

**Listed but not opened** (anything said about them is marked `[CHECK]`):
- **Gateway:** `server.ts`, `dispatch.ts`, `pool.ts`, `catalog.ts`, `routing/jev.ts`, `routing/freepool.ts`
- **Paywall:** `rig.ts`, `pay.ts`, `src/config.ts`
- **Whole folders:** `services/web`, `test-console`, `packages/route-engine`, all tests

---

## 2. Fix first: secrets in a committed file

`.env.example` holds what look like real values: the gateway key, an OpenRouter key and the three tenant seeds. `.gitignore` has `!.env.example`, so this file gets committed. This breaks `CLAUDE.md`'s secret rule and the file's own header.

---

## 3. Status by plan layer

| Plan layer | Status | Evidence |
|---|---|---|
| **L0 Rigs** | R1 **PASS**. R2–R12 not started. R7 is impossible until `agent.ts` gets an Ollama option. | [LOG], [CODE] |
| **L1 Many buyers, private AI** | **Partial.** Done: 3 tenants pay; files are read only inside `docs/`; client masking; a self-check before anything is sent; the payment ceiling; the restore stays on the screen. Missing: generated CSV/JSON test data, canary records, pre-flight with a T0 local tier, minimum-context shaping, signed header, `/verify` call, local ACTUS what-if. | [CODE] |
| **L2 Intents, limits, escalations** | **Not started on the server.** The limits exist only on the client (`AskSession`, rig `maxSpend`). | [CODE] |
| **L3 Screens** | Not started. The agent terminal lines exist. `test-console` exists, but I haven't read it. | [CODE] |
| **L4 AWS** | **Partial.** The Strands agent on Bedrock is coded and tested (90/90 on your PC), but has not run against Bedrock yet. The typed prompt is **not masked**, which breaks the Pattern B rule. No KMS. The gateway has no Bedrock source. | [LOG], [CODE] |
| **L5 Lending** | Not started. | — |
| **L6 Stretch** | Not started. | — |

### Hook points confirmed in the code
- **Paywall:**
  - `server.onBeforeVerify` and `server.onAfterSettle` in `app.ts`. These are the mandate hooks.
  - In `proxy()`, the request header allow-list holds only `authorization` and `content-type`. The preflight header has to be added there.
- **Payment core:** `XrplSigner` and `checkSigned` in `xrpl.ts`. A KMS signer plugs in here with no change to the payment code.
- **Gateway:**
  - `clientPlaceholderTypes` already makes client masking "stricter, never looser".
  - `decide()` in `chat.ts` is where a preflight merge and `--on-server-detect` would sit.
- **Analyst:** `/evidence` (budgeted minimum context) and `/verify` (numbers in an answer that are missing from the evidence) already exist.

### Rule conflicts to settle before coding
- `CLAUDE.md` requires an ARCH-ID for all code. L0 and L1 have none.
- ARCH-002 freezes the gateway's privacy pipeline. Iterations I3, I6 and I8 touch the gateway, so each needs a new ARCH-ID first.

---

## 4. Iterations

Each iteration closes with real command output in `BUILD_LOG.md`, an updated `STATE.md`, and manual steps added to `MANUAL_SETUP.md`. Every new behaviour gets a flag with a default; the defaults keep current behaviour unless stated.

### I0 — Hygiene, ARCH-IDs, layer names (≈ 30 min)
- **AI:**
  - Blank the values in `.env.example`.
  - Draft an ARCH-019+ addendum, one ID per iteration below.
  - Record the layer-name mapping in `STATE.md`.
- **Manual:** rotate the OpenRouter key and the gateway key, check `git log -p -- .env.example`, and accept or edit the ARCH-IDs.
- **Done when:** `.env.example` has empty values and all suites stay green: gateway 266, paywall 90, web 105.

### I1 — Finish the Bedrock runs the code is waiting on (≈ 30 min, owner)
- **Manual:** `MANUAL_SETUP.md` L1 steps 2–4: AWS identity, dry run, then a paid run on Wi-Fi.
- **Done when:** you see one line `[chainaim_private_ask] …: answered, 0.01 RLUSD, tx …` plus one `payment_settled`.

### I2 — Plan L0: rig scripts R2–R6, R9, R12 (≈ 3–4 h)
- **New folder `scripts/rigs/`:**
  - One script per rig, each appending `{rig, pass, detail, ts}` to `rig/out/rigs.jsonl`.
  - Shared flags: `--network`, `--ws`, `--region`, `--timeout-ms`.
- **Per rig:**
  - **R2 `quicknode.ts`:** `--ws-env QUICKNODE_WS_TESTNET`. Subscribe, wait for a payment, then `account_tx`.
  - **R3 `devnet-lending.ts`:** wraps xrpl.org `lendingSetup.js`. **[CHECK]** whether xrpl.js 4.7.0 has the LoanSet types; the amendments and vault type on Devnet.
  - **R4 `actus.ts`:** `--actus-url`; PAM and ANN `/eventsBatch`; compare with `PeriodicPayment`.
  - **R5 `bedrock.ts`:** Converse on `--model-id` (Nemotron 3 Nano and Claude Sonnet 4.6).
  - **R6 `kms-p256.ts`:** sign, then verify locally as JWS.
  - **R9 `presidio-isolation.ts`:** from inside the container, an outbound call must fail.
  - **R12 `latency.ts`:** rows 1/10/50/200 × models × `--pay on|off`; prints p50 and p95.
- **Dependencies:** `@aws-sdk/client-kms`, `@aws-sdk/client-bedrock-runtime`.
- **Manual:** Quicknode endpoint, Bedrock model access, a KMS key, ACTUS ports closed, the Presidio network made `--internal`.
- **Done when:** every rig has a PASS or FAIL line. Any FAIL moves its feature to the roadmap.

### I3 — Plan L1: the full client pipeline (≈ 4–5 h)
- **Generated test data and canaries:**
  - `scripts/gen-tenant-data.ts` writes per-tenant CSV/JSON (invoices, payments, bank lines, notes) under `rig/tenants/<id>/data/`.
  - About 50 canary records go into `canary.json`.
  - Flags `--seed N`, `--canaries 50`.
- **Pre-flight and minimum context:**
  - A new `scripts/preflight.ts` calls the analyst `/profile`, `/analyze` and `/evidence` and assigns a tier: **T0** = answer locally for free; refuse when unanswerable (nothing charged); otherwise pick the **minimum-context shape** from the design §10.
  - Flags `--max-rows 50`, `--max-chars 12000`.
- **Signed header:** `X-ChainAim-Preflight` (classes, counts, tier, self-check), signed with the tenant key.
- **Paywall and gateway:**
  - `app.ts` forwards `x-chainaim-preflight`.
  - The gateway `chat.ts` `decide()` merges it, "stricter, never looser".
  - New flag `--on-server-detect mask|refuse|upgrade` (default `mask`).
- **Agent tool:**
  - Masks the typed prompt before `agent.invoke` (`--prompt-mask on`).
  - Gets a `chainaim_ask_books(question)` tool next to `chainaim_private_ask`.
- **After the answer:** call `/verify`.
- **Tests:**
  - A header that understates the class never loosens the policy.
  - `refuse` is not settled.
  - A T0 answer makes no payment.
  - The prompt is masked.
  - Canaries appear in no model input. The stub already records model inputs.
- **Done when:** the rig runs on generated data, the canary report says "none reached a model", and there is one T0 and one refused example.

### I4 — Plan L2: mandates, running total, escalations (≈ 4–6 h)
- **New `services/paywall/src/mandates.ts`** on `node:sqlite`:
  - Tables `mandates`, `spend` (reserved / committed / released / pending) and `escalations`.
  - `reserve` in `onBeforeVerify`; `commit` in `onAfterSettle`; `release` on refusal; a timeout leaves it `pending`.
- **Mandate format:** a VI-shaped JWS (ES256) signed by the officer key (KMS P-256), sent as `X-ChainAim-Mandate`. One use per slip.
- **Refusals:** an x402 `error` of `mandate_missing`, `mandate_exceeded` or `escalated`. The client parks the item, the agent carries on, and the item expires after `--escalation-ttl-min 30`.
- **Privacy escalations** stay on the client, and nothing is sent.
- **Flags:**
  - `--mandate-mode off|shadow|strict` (default `off`)
  - `--mandate-db`
  - `--officer-keys PATH` (public keys per tenant)
- **[CHECK]** in the `@x402/core` 2.27 type definitions: the payer and payload fields on `ctx`, and whether a hook exists for "verified but not settled".
- **Tests:**
  - Two concurrent calls racing the cap: only one gets through.
  - `shadow` mode never refuses.
  - Strict refusals are free.
  - A replayed slip is refused.
  - An expired escalation is refused.
- **Done when:** a tenant with a 0.03 daily cap settles 3 calls, the 4th is escalated, and after the CFO approves (I5), the parked item pays.

### I5 — Plan L3: screens (≈ 3–4 h)
- **What to build:**
  - The CFO console: approvals inbox, Approve once / Raise limit / Deny, each signed with the officer key.
  - The ChainAim control room: six panels (design §6), including the **seller-wallet meter via Quicknode** and the cost estimate per destination.
  - Refusals shown as cards.
- **Where:** extend `test-console/console` (structure not read; **[CHECK]**) or create a new `services/admin`. **Your decision.**
- **Data sources:**
  - the paywall `payment_settled` log
  - the mandate database
  - the gateway decision ledger (`data/ledger`, no text)
  - `rig/out`
  - Quicknode
- **Done when:** the storyline steps 2–3 are visible live: payment, meter, escalation, approval, then the parked item paid.

### I6 — Plan L4: AWS completion (≈ 2–3 h)
- **KMS signer:** a new `scripts/kms-signer.ts` implementing `XrplSigner` with Ed25519 (`--signer seed|kms`, `--kms-key-id`). **[CHECK]** whether the KMS Ed25519 raw-sign path works with XRPL, and how the address is derived.
- **Bedrock as ChainAim's answering model:** add it as a `catalog` deployment or as a third `--model-source`. **[CHECK]** `pool.ts` / `catalog.ts`. Needs an ARCH-ID.
- **Pattern A:** `agent.ts --provider bedrock|ollama --ollama-url --model-id`, which makes R7 possible.
- **Done when:**
  - R7 passes.
  - A rig run with `--signer kms` settles.
  - The ledger records a call served by Bedrock.

### I7 — Plan L5: lending, channel B (≈ 4–6 h)
- **Revenue wallet:** customer wallets pay Jupiter's revenue wallet on Testnet, with memo = invoice number.
- **Ticket:** Kestrel buys it through `/v1/disclose/ticket`, paid by x402.
- **Checker:**
  1. Builds the ACTUS schedule from the terms only.
  2. Computes `ledger_verified_share` via Quicknode.
  3. Runs the scenarios.
  4. Writes the result fields `proof_type`, `data_sources`/level, `consistency_score`, `ledger_verified_share`, and a fingerprint.
  5. ChainAim signs it with its KMS key.
- **Submission:** the CFO signs the submission.
- **On Devnet:** vault → broker → cover → Harbor deposit → LoanSet with `Data` (version | result hash | submission hash | verdict | source level) → LoanPay.
- **Lender-side verifier:** a script that checks both signatures and the `Data` hash.
- **Done when:** honest data → approved and a loan is created; inflated invoices → "insufficient evidence".

### I8 — Plan L6: stretch (as time allows)
- Enclave-signed attestation (R10 first).
- ZK-PRET GLEIF proof (R11, needs a verified LEI) or a coverage proof.
- Vault stress; Ledger device.

### I9 — End-to-end storyline run
One script runs the 3-minute storyline:
1. **Morning:** T0 free answer, then a refusal.
2. **Working:** a paid, masked call with canaries.
3. **Limits:** cap → escalation → approve; a "send the full ledger" request is denied.
4. **The big order:** loan via channel B, then inflated books → "insufficient evidence".

- **Done when:** one run log contains every step's transaction hashes and refusal cards.

---

## 5. Order and cut line

**Order:** I0 → I1 → I2 → I3 → I4 → I5 (this is the core: plan L0–L3, about 8 h) → I6 → I7 → I8 → I9.
**Cut line:** if time runs short, deliver I0–I5 and show I6–I8 as the roadmap.

## 6. Decisions needed
1. ARCH-ID addendum approach.
2. Default `--mandate-mode` for the demo: `strict` or `shadow`.
3. Screens: extend `test-console` or create a new `services/admin`?
4. Copy plan v3 (`FINAGENTS\DESIGN\xrplh-3-HACKATHON-PLAN-v3-2026-10-23T0312.md`) from the other machine into this folder, so the gaps listed in the companion file can be closed.
