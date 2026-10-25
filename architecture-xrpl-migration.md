# architecture.md — ChainAim Privacy Gateway: Algorand/USDC → XRPL/RLUSD Migration

**Document status:** Draft specification for review
**Target repo:** `C:\SATHYA\CHAINAIM3003\mcp-servers\FINAGENTS\FINAGENTS3\chainaim-router-XRP`
**Date:** 2026-10-13
**Intended use:** This document is written to the ARCH-ID convention defined in the project's `CLAUDE.md`, so that `/plan` can derive `TASKS.md` from it and the hooks can trace every task to a requirement.

> **Do not merge this over the existing `architecture.md` until Section 9 (Verification Debt) is cleared.** It is deliberately named `architecture-xrpl-migration.md` because `CLAUDE.md` designates `architecture.md` as user-owned ground truth that agents must never edit.

---

## 1. Scope and Prime Directive

### 1.1 The one-sentence change

Replace the payment rail — Algorand + USDC + the GoPlausible facilitator — with XRPL + RLUSD + the t54 facilitator. **Nothing else changes.**

### 1.2 Prime Directive (ARCH-001)

**ARCH-001 — Behavioural equivalence.** Every externally observable behaviour of the system, other than which chain and token settle the payment, must be identical before and after this migration. Same routes, same request and response shapes, same masking semantics, same placeholder format, same restore behaviour, same data-class policy, same free-model routing, same error messages (except where they name a chain or token), same prices in dollars.

A test that passes today and does not concern payment must pass unchanged after the migration. Per `CLAUDE.md` non-negotiable #4, no test may be weakened to achieve this.

### 1.3 Why this is a contained change

Verified by direct reading of `services/paywall/src/app.ts`: the paywall strips every payment header before proxying to the gateway, forwarding only `authorization`, `content-type`, method, path and body. The gateway therefore has no knowledge of the payment rail and cannot acquire any. The privacy pipeline is structurally insulated from this migration.

---

## 2. Invariants — What Must Not Change

### ARCH-002 — The privacy pipeline is untouched

The following must not be modified by any task in this migration:

| Path | Role |
|---|---|
| `services/gateway/src/privacy/mask.ts` | `Masker` class, placeholder allocation, conversation walking |
| `services/gateway/src/privacy/restore.ts` | Placeholder restoration, unresolved counting |
| `services/gateway/src/privacy/classify.ts` | PHI/PCI/PII classification, data policy |
| `services/gateway/src/privacy/presidio.ts` | Presidio client |
| `services/gateway/src/privacy/entities.ts` | Entity type predicates |
| `services/gateway/src/routing/**` | Jev, free pool, quota, scores, select |
| `services/gateway/src/chat.ts`, `dispatch.ts`, `pool.ts`, `ledger.ts`, `catalog.ts`, `openrouter.ts` | Chat pipeline and ledger |
| `services/presidio/**` | Analyzer image and recognizers |
| `packages/route-engine/**` | Rules classifier |
| `config/free-models.json` | Scoring table |

**Verified:** `mask.ts`, `restore.ts`, `classify.ts` read in full. They contain zero chain, token, wallet or payment references. The remainder are asserted untouched on the strength of the architectural boundary in `app.ts`, and must be confirmed during the sweep in Section 9.

### ARCH-003 — Placeholder format is frozen

`<TYPE_N>` server-side and `<C_TYPE_N>` client-side, with `[CARD REMOVED]` for card data. These appear in the Bazaar discovery examples in `routes.ts` and in client-side masking. The migration must not alter them.

### ARCH-004 — Prices stay denominated in dollars

Prices are configured as USD strings (`$0.01`) in `PRICE_SCAN`, `PRICE_MASK`, `PRICE_CHAT`, validated by a regex permitting at most 6 decimal places. RLUSD is a dollar stablecoin, so these values carry over unchanged and continue to mean the same thing.

**This is a hard constraint on asset choice.** Pricing in XRP instead of RLUSD would replace a fixed dollar price with a floating exchange rate and change the amount format from decimal to integer drops. XRP is therefore out of scope as a settlement asset for this system.

### ARCH-005 — The payment/privacy isolation boundary holds

The paywall must continue to strip all payment headers before proxying. The gateway must never learn the payer's address. The decision ledger must never record a payer, a transaction hash or a network.

---

## 3. Verified External Facts

Every fact in this section was read from a primary source during this session. Nothing here is from recollection.

### 3.1 The t54 XRPL x402 facilitator

Source: `https://xrpl-x402.t54.ai/` and `https://xrpl-x402.t54.ai/docs/xrpl-scheme`

- Implements the **same `exact` scheme** as the Algorand integration.
- **Same settlement model:** the payer signs a standard XRPL `Payment` transaction; the facilitator submits the signed blob. The facilitator never signs payer transactions and never holds customer private keys.
- **The payer pays the network fee**, included in the signed transaction.
- Exposes the spec-standard `/supported`, `/verify`, `/settle` endpoints.
- Settles XRP and IOU assets including RLUSD and USDC.

### 3.2 Network identifiers (CAIP-2)

| Network | Identifier |
|---|---|
| Mainnet | `xrpl:0` |
| Testnet | `xrpl:1` |
| Devnet | `xrpl:2` |

### 3.3 Facilitator endpoints

| Network | URL | Source |
|---|---|---|
| Mainnet | `https://xrpl-facilitator-mainnet.t54.ai` | t54 homepage |
| Testnet | `https://xrpl-facilitator-testnet.t54.ai` | **Supplied by the project owner, not independently verified** |

### 3.4 RLUSD identity

Source: Ripple official documentation, `docs.ripple.com/products/stablecoin/developer-resources/rlusd-on-the-xrpl`

| Item | Value |
|---|---|
| Canonical currency code | `524C555344000000000000000000000000000000` |
| Mainnet issuer | `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De` |
| Testnet issuer | `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV` |

RLUSD is confirmed available on **both** Mainnet and Testnet. This was the single largest risk to the migration and it is resolved: the testnet path remains a true dollar-stablecoin flow and does not need to degrade to XRP.

> **Standing caution.** XRPL's own developer documentation advises that the mainnet issuer address be re-verified against Ripple's official documentation before production use. Treat the mainnet issuer as a value to confirm at deploy time, never as a frozen constant.

### 3.5 XRPL Testnet endpoints

| Item | Value |
|---|---|
| JSON-RPC | `https://s.altnet.rippletest.net:51234/` |
| WebSocket | `wss://s.altnet.rippletest.net:51233/` |
| Faucet | `https://faucet.altnet.rippletest.net/accounts` |

### 3.6 The XRPL `exact` payload shape

`PAYMENT-SIGNATURE` (base64 JSON), IOU form:

```
{
  "x402Version": 2,
  "accepted": {
    "scheme": "exact",
    "network": "xrpl:1",
    "asset": "524C555344000000000000000000000000000000",
    "payTo": "r...",
    "amount": "0.01",
    "maxTimeoutSeconds": 600,
    "extra": {
      "sourceTag": 804681468,
      "issuer": "r...",
      "invoiceId": "..."
    }
  },
  "payload": { "signedTxBlob": "1200002280000000..." }
}
```

Required fields on each `accepts` entry: `scheme`, `network`, `asset`, `payTo`, `amount`, `maxTimeoutSeconds`, `extra.invoiceId`, `extra.sourceTag`. `extra.issuer` is required for IOU assets. `extra.destinationTag` is optional.

Headers are the x402 v2 standard set — `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE` — **identical to the Algorand integration**. This is why `services/web/src/relay.ts` needs no header changes.

### 3.7 Invoice binding (replaces the hand-rolled replay guard)

The signed transaction MUST commit to the invoice, by one of:

- **Memos:** `MemoData = HEX(UTF-8(invoiceId))`
- **InvoiceID field:** `InvoiceID = SHA256(invoiceId)`

The facilitator rejects transactions without valid binding. It additionally enforces: destination match, network binding via `NetworkID`, amount match, presence of `LastLedgerSequence` for bounded expiry, fee limits, and refusal of partial or cross-currency payments.

### 3.8 Client SDK

Source: t54 TypeScript client guide.

- Package: `x402-xrpl`, alongside `xrpl`
- Client entry point: `x402Fetch({ wallet, network })`
- Wallet construction: `Wallet.fromSeed(seed)` from the `xrpl` package
- Helpers: `decodePaymentRequiredHeader`, `decodePaymentResponseHeader`, `resolveCurrencyCode`
- Documented merchant middleware: **FastAPI and Express only**

---

## 4. Concept Mapping

| Algorand / USDC (current) | XRPL / RLUSD (target) |
|---|---|
| 58-character base32 address | Classic address, `r...` |
| 25-word mnemonic | Family seed, `sEd...` |
| USDC = ASA id `10458941` | RLUSD = currency code + **issuer address** |
| Asset opt-in | **Trust line** to the RLUSD issuer |
| Minimum balance, ALGO per asset | Base reserve + owner reserve per trust line, in XRP |
| `algorand:SGO1GK...` / `algorand:wGHE2Pw...` | `xrpl:1` / `xrpl:0` |
| GoPlausible facilitator | t54 facilitator |
| Fee in ALGO, paid by payer | Fee in XRP, paid by payer, inside the signed tx |
| `ReplayGuard` in `replay.ts` | Protocol-level invoice binding |
| `extra.tag` (challenge tag) | `extra.invoiceId` + `extra.sourceTag` |
| Lute wallet (browser) | Xaman / GemWallet / Crossmark |
| `@x402/avm`, `@x402-avm/extensions` | `x402-xrpl` |
| Algod REST (`/v2/accounts/{addr}`) | XRPL JSON-RPC (`account_info`, `account_lines`) |

### 4.1 The two concepts with no Algorand analogue

**Trust lines.** Functionally parallel to the ASA opt-in, but an IOU is identified by *currency code plus issuer*, not a single integer. Both the pay-to account and every buyer need one.

**Invoice binding.** The protocol requires each signed payment to be cryptographically bound to one invoice. This is a net simplification — it supersedes custom replay protection.

---

## 5. Requirements

### ARCH-010 — Network switching via a single variable

A single `XRPL_NETWORK` variable selects `testnet` or `mainnet`. All chain-specific values exist as `_TESTNET` / `_MAINNET` pairs. The loader resolves the active pair and validates only that pair, so the inactive network's values may be blank during development.

This follows the existing configuration philosophy in `config.ts`: fail fast with a named error, validate shape at load time, never read a secret into a log line.

### ARCH-011 — Configuration surface

Chain-neutral, unchanged: `CHAINAIM_GATEWAY_KEY`, `OPENROUTER_API_KEY`, `GATEWAY_URL`, `PUBLIC_BASE_URL`, `PRICE_SCAN`, `PRICE_MASK`, `PRICE_CHAT`, `GATEWAY_TIMEOUT_MS`, `PORT`, `HOST`.

New, paired:

```
XRPL_NETWORK=testnet

XRPL_CAIP2_TESTNET=xrpl:1
XRPL_CAIP2_MAINNET=xrpl:0

XRPL_RPC_URL_TESTNET=https://s.altnet.rippletest.net:51234/
XRPL_RPC_URL_MAINNET=
XRPL_WS_URL_TESTNET=wss://s.altnet.rippletest.net:51233/
XRPL_WS_URL_MAINNET=

FACILITATOR_URL_TESTNET=https://xrpl-facilitator-testnet.t54.ai
FACILITATOR_URL_MAINNET=https://xrpl-facilitator-mainnet.t54.ai

RLUSD_CURRENCY_CODE=524C555344000000000000000000000000000000
RLUSD_ISSUER_TESTNET=rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV
RLUSD_ISSUER_MAINNET=rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De

XRPL_PAY_TO_TESTNET=
XRPL_PAY_TO_MAINNET=

XRPL_SOURCE_TAG=804681468
XRPL_MAX_TIMEOUT_SECONDS=600

XRPL_TESTNET_FAUCET_URL=https://faucet.altnet.rippletest.net/accounts
```

Script-only, never read by a service, never committed:

```
XRPL_BUYER_SEED_TESTNET=
XRPL_BUYER_SEED_MAINNET=
```

Retired: `AVM_PAY_TO`, `AVM_MNEMONIC`, `X402_NETWORK`, `FACILITATOR_URL` (unsuffixed).

Per `CLAUDE.md` non-negotiable: `.env.example` carries **names with empty values only**.

### ARCH-012 — Address validation

Replace the Algorand validator `/^[A-Z2-7]{58}$/` with XRPL classic-address validation. A length-and-charset regex alone is insufficient — XRPL addresses carry a base58 checksum, and an address that passes a naive regex but fails the checksum will be accepted at config load and fail at settlement. Validation must verify the checksum.

### ARCH-013 — Invoice generation and lifecycle

The paywall must generate a unique `invoiceId` per payment challenge, advertise it in `extra.invoiceId`, and consume it once settlement succeeds. Idempotency is a stated security consideration of the scheme.

### ARCH-014 — `ReplayGuard` retirement

`services/paywall/src/replay.ts` exists because, in the Algorand integration, a refused call was never settled and nothing else prevented a replayed payment from draining the free-model quota. Invoice binding plus invoice consumption now provide this at protocol level. The guard is to be removed, not ported.

> **Inference, not verification.** `replay.ts` was never read in full; its purpose is inferred from its two call sites in `app.ts` (`onBeforeVerify` → `replays.claim(paymentKey(...))`). Read the file before removing it, in case it carries behaviour beyond replay prevention.

### ARCH-015 — Balance and trust-line reads

`services/web/src/balance.ts` currently reads an Algod REST endpoint and reports `{ algo, usdc, optedIn }`. The XRPL equivalent reads `account_info` for the XRP balance and `account_lines` for the RLUSD trust line, reporting `{ xrp, rlusd, trustLineOpen }`. The `optedIn` → `trustLineOpen` rename must propagate to every consumer, including the wallet chips in the web UI.

### ARCH-016 — Browser wallet signer

`lute-signer.ts` adapts Lute's `signTxns` to the `{ address, signTransactions }` interface that `ExactAvmScheme` accepts. An equivalent adapter is required for the chosen XRPL wallet.

**This requirement is blocked.** See Section 8, Open Question 1.

### ARCH-017 — Merchant middleware on Hono

The paywall is built on Hono (`@x402/hono`). t54 documents Express and FastAPI middleware only. Either `x402-xrpl` exposes framework-agnostic primitives that can be wrapped for Hono, or an adapter must be written.

**This requirement is blocked.** See Section 8, Open Question 2.

### ARCH-018 — No residual Algorand or USDC references

On completion, the repository must contain no Algorand, ALGO, USDC, AVM, Lute or GoPlausible reference in code, configuration, tests, scripts, documentation or dependencies — except where a document is deliberately recording migration history.

**This requirement cannot currently be verified.** See Section 9.

---

## 6. File-by-File Change Inventory

### 6.1 Verified — files read directly this session

| File | Disposition | Detail |
|---|---|---|
| `services/paywall/src/config.ts` | **Rewrite** | `NETWORKS` map, `CHALLENGE_TAG`, `DEFAULT_FACILITATOR`, `AVM_PAY_TO` and its regex, `X402_NETWORK`. Add paired resolution, issuer, currency code, source tag, timeout. |
| `services/paywall/src/app.ts` | **Edit** | Replace `ExactAvmScheme` registration and `bazaarResourceServerExtension`; repoint facilitator; remove `ReplayGuard` wiring; retain proxy, body limit, capacity guard, settle logging, header stripping **unchanged**. |
| `services/paywall/src/routes.ts` | **Edit** | `accepts` entry gains `asset`, `extra.issuer`, `extra.invoiceId`, `extra.sourceTag`, `maxTimeoutSeconds`; drop `extra.tag`. Replace `declareDiscoveryExtension` if Bazaar is Algorand-specific. **Route descriptions, schemas and examples must not change** (ARCH-003). |
| `services/paywall/src/replay.ts` | **Delete** | Per ARCH-014, after reading it. |
| `services/paywall/scripts/new-account.ts` | **Rewrite** | Algorand seed/mnemonic → `Wallet.generate()`. |
| `services/paywall/scripts/opt-in.ts` | **Rewrite → `trust-line.ts`** | ASA opt-in → `TrustSet` to the RLUSD issuer. Reserve guidance replaces the 0.3 ALGO guidance. |
| `services/paywall/scripts/pay.ts` | **Rewrite** | `AVM_MNEMONIC` → `XRPL_BUYER_SEED_*`; x402 client → `x402Fetch`. **Preserve `--dry-run`** and its price-quote output. |
| `services/paywall/scripts/send-algo.ts` | **Rewrite → `send-xrp.ts`** | Funding helper. |
| `services/web/src/balance.ts` | **Rewrite** | Per ARCH-015. |
| `services/web/src/lute-signer.ts` | **Delete, replace** | Per ARCH-016. |
| `services/web/src/wallets.ts` | **Edit** | `TESTNET` constant, `networkName()`, `networkInfo()`, `genesisId` → XRPL equivalents; `readQuote` divides by `1e6` for USDC micro-units — RLUSD amounts are **decimal strings**, so this conversion must be removed, not adjusted. |
| `services/web/src/pay.ts` | **Rewrite** | `ExactAvmScheme`, `PayNetwork`, Lute wiring. **Preserve the money-safety semantics verbatim**: once signed, never claim "not charged". |
| `services/web/src/relay.ts` | **No change expected** | Header names are x402 v2 standard and chain-neutral. Confirm `PASS_BACK` needs no additions. |
| `.env.example` | **Rewrite** | Per ARCH-011. |
| `PROJECT_CONTEXT.md` | **Edit** | Sources of truth, component table, constraints. |

> **Note on `wallets.ts`.** The `amount / 1e6` conversion is a genuine correctness trap. USDC amounts arrive as integer micro-units; RLUSD IOU amounts arrive as decimal strings. Dividing a decimal RLUSD amount by 1e6 would under-report the price by six orders of magnitude without throwing. This appears in at least `wallets.ts` and `scripts/pay.ts`.

### 6.2 Not yet read — must be swept before this table is complete

`services/paywall/src/main.ts` · `services/paywall/package.json` · all six files under `services/paywall/test/` (notably `pay.test.ts`, `stubs.ts`, `config.test.ts`) · `services/paywall/scripts/client-mask.ts` · `services/paywall/scripts/private-ask.ts` · `services/web/src/` — `config.ts`, `main.ts`, `app.ts`, `answer.ts`, `wallet-entry.ts`, `vercel-api.ts`, `buffer-shim.ts`, `mask.ts` · `services/web/public/` — `index.html`, `wallet.js`, `cookies.html` · `services/web/scripts/` — `build-wallet.ts`, `build-vercel.ts` · all 13 files under `services/web/test/` · root `package.json` · `services/web/package.json` · `build.config.json` · `config/**` · `docs/**` · `eval/**` · `test-console/**` · `README.md`, `SETUP.md`, `DEMO.md`, `HOW-TO-USE.md`, `ONBOARDING.md`, `architecture.TEMPLATE.md` · all Dockerfiles and `railway.json` files

---

## 7. Deletion List

### 7.1 Confirmed deletions

| Item | Reason |
|---|---|
| `services/paywall/src/replay.ts` | Superseded by invoice binding (ARCH-014) |
| `services/web/src/lute-signer.ts` | Lute is Algorand-only (ARCH-016) |
| `services/web/test/lute-signer.test.ts` | Tests a deleted file |
| `services/paywall/scripts/opt-in.ts` | Replaced by `trust-line.ts` |
| `services/paywall/scripts/send-algo.ts` | Replaced by `send-xrp.ts` |
| Dependencies `@x402/avm`, `@x402-avm/extensions`, `@algorandfoundation/algokit-utils` | Algorand-only |

### 7.2 Probable deletions, pending the sweep

`services/web/src/buffer-shim.ts` likely exists to polyfill `Buffer` for Algorand signing libraries in the browser; `x402-xrpl` may not need it. `services/web/scripts/build-wallet.ts` bundles the Lute wallet entry point and may be obsolete or merely need retargeting. Neither has been read — do not delete on this basis alone.

### 7.3 Explicitly NOT deleted

Nothing under `services/gateway/`, `services/presidio/`, `packages/route-engine/` or `config/free-models.json`. If a migration task proposes touching these, the task is wrong.

---

## 8. Open Questions — Blocking

### Open Question 1 — Does `x402Fetch` accept a pluggable signer?

The documented TypeScript client takes `x402Fetch({ wallet, network })` where `wallet` is an `xrpl.Wallet` holding the private key. The Algorand integration worked with browser wallets because `ExactAvmScheme` accepted an arbitrary `{ address, signTransactions }` signer, letting Lute sign without exposing a key.

- **If a custom signer is supported:** ARCH-016 is a small adapter, directly analogous to `lute-signer.ts`.
- **If not:** the browser path requires building the presigned blob manually and handing it to the chosen wallet for signing — substantially more work, and the single largest cost driver in this migration.

**Resolution:** install `x402-xrpl` and read its source and type definitions.

### Open Question 2 — Hono middleware

Does `x402-xrpl` expose framework-agnostic verify/settle primitives, or only Express middleware? Determines whether ARCH-017 is a thin wrapper or a port.

**Resolution:** same install, same read.

### Open Question 3 — Testnet facilitator URL

`https://xrpl-facilitator-testnet.t54.ai` was supplied by the project owner. It is consistent with the published mainnet hostname but was not confirmed against t54's own environment matrix. Confirm before relying on it.

### Open Question 4 — Bazaar discovery

The Algorand paywall registers `bazaarResourceServerExtension` from `@x402-avm/extensions` and declares per-route discovery metadata, which feeds the GoPlausible Bazaar and the challenge leaderboard. Whether an XRPL equivalent exists, and whether discovery metadata should be retained at all once the challenge context is gone, is unresolved. Discovery metadata is advertising, not function — the paid routes work without it.

---

## 9. Verification Debt

**The inventory in Section 6 is incomplete, and Section 7 is therefore provisional.**

Thirteen files were read directly from the repository during this session and are reported as verified. The sweep of the remaining files — well over half the Algorand surface area, including all three `package.json` files, the entire test suite, the web UI, all documentation and all deployment configuration — could not be completed because the filesystem path became unreachable mid-session.

**ARCH-018 cannot be signed off until that sweep runs.** The highest-risk unswept areas, in order:

1. **`package.json` × 3** — the dependency list is the strictest reading of "nothing Algorand-related may remain", and a transitive Algorand dependency will not show up in a text search of source files.
2. **The test suites** — 19 test files across paywall and web. Payment tests will fail by design and need rewriting; privacy tests must pass untouched, and are the proof of ARCH-001.
3. **`services/web/public/` and the UI** — user-visible strings naming ALGO, USDC, Lute or Algorand.
4. **`docs/**` and the five root markdown files** — `docs/deploy/railway.md` and the design and plan documents referenced from `PROJECT_CONTEXT.md`.

Run the sweep as the first task of the build, before any code is written.

---

## 10. Staged Plan

Sequenced so that each stage de-risks the next, and the cheapest proof of the whole chain comes early.

**Stage 0 — Resolve the blockers.** Install `x402-xrpl` and `xrpl`; read the source. Answer Open Questions 1 and 2. Complete the Section 9 sweep and finalise Sections 6 and 7. *No production code written.*

**Stage 1 — Configuration.** Rewrite `config.ts` and `.env.example` per ARCH-010, ARCH-011, ARCH-012. Update `config.test.ts`. Nothing settles yet; this is pure shape.

**Stage 2 — Wallet setup (manual, owner-led).** Create testnet buyer and pay-to accounts, fund from the faucet, open RLUSD trust lines on both. Buyer and pay-to must be **separate accounts**. Seeds go into `.env` on the owner's machine and are never transmitted.

**Stage 3 — The agent path.** Rewrite `new-account.ts`, `trust-line.ts`, `send-xrp.ts`, `pay.ts`. Prove a real settled RLUSD payment on testnet from the command line. *This is the milestone that proves the migration works*, and it needs no wallet UI.

**Stage 4 — The paywall.** Rewrite `app.ts` and `routes.ts`; wire the facilitator; remove `replay.ts`. Verify the full 402 → sign → verify → settle → proxy cycle, and confirm the gateway still receives no payment headers.

**Stage 5 — The browser path.** Signer adapter, `balance.ts`, `wallets.ts`, `pay.ts`, UI strings. Scope depends entirely on Open Question 1.

**Stage 6 — Sweep and documentation.** Re-run the ARCH-018 audit, update all documentation, `PROJECT_CONTEXT.md` and deployment configuration.

**Stage 7 — Mainnet.** Re-verify the mainnet RLUSD issuer per Section 3.4. Populate the `_MAINNET` pair. Flip `XRPL_NETWORK`.

---

## 11. Division of Labour

**Automatable:** every file edit, dependency change, test rewrite, documentation update, and the Section 9 sweep.

**Owner-only:** account creation, faucet funding, trust-line approval, seed placement in `.env`, mainnet issuer confirmation, and production deployment. Seeds must never appear in a chat transcript, a commit, or any file other than a local `.env`.

Per `CLAUDE.md` non-negotiable #5, version control is handled by the owner by hand throughout.
