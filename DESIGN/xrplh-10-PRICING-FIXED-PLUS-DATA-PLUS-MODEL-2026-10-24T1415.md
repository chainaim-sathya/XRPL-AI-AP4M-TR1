# xrplh-10 — Pricing every ChainAim call: fixed + data/compute + model estimate, paid in RLUSD

Breadcrumb: DESIGN/README.md → xrplh-6 (ask/payment coupling) → xrplh-9 (client-side mask/restore) → **xrplh-10** (this).
Status: DESIGN, not built. Written 2026-10-24 14:15 (UTC-05:00).
Legend: [CODE] read in this repo · [WEB] read from a source this session · [ASSUME] to be checked by a rig first.

## 1. Owner's requirement (2026-10-24)
Every flow (UI and terminal) is paid. Price of one call = **fixed** + **variable 1: data/compute** (masked fields, data processed,
ACTUS calls) + **variable 2: model estimate** (input/output tokens x the model's price). The seller wallet receives the sum.
Defaults: fixed **0.1 RLUSD**, both variable parts **0**. The estimate comes from **one function**, callable on its own.
Later the parts are tuned so value-added services are priced.

## 2. Facts this design builds on
- x402 "exact": the buyer signs an exact RLUSD amount quoted BEFORE the work; no metering after [CODE paywall + CHAT].
- The paywall's per-request price can be a function, but that function sees **headers, not the body** (@x402/core DynamicPrice,
  HTTPRequestContext: path, method, headers, query) [CODE node_modules/@x402/core, read 2026-10-24].
- The payment is bound to the invoice, not to the body [CODE invoices.ts].
- Every catalog model already carries pricing.inputPerM / outputPerM (USD per 1M tokens); Bedrock Nemotron Sydney 0.0618 /
  0.2472 [WEB aws.amazon.com/bedrock/pricing, 2026-10-24]; local and OpenRouter-free = 0 [CODE].
- RLUSD amounts: at most 6 decimals (paywall config rule) [CODE].
- With xrplh-9, masking happens on the PC, so the PC knows how many fields it masked and how much data it processed; the
  server sees only placeholders and can recount them.

## 3. Design
### 3.1 One config file: `config/pricing.json` (in git; prices only, no secrets)
```json
{
  "currency": "RLUSD",
  "fixed": 0.1,
  "data": { "perMaskedField": 0, "perKBSent": 0, "perRowProcessed": 0, "perActusCall": 0 },
  "model": { "costShare": 0, "charsPerToken": 4, "maxOutputTokensDefault": 2048 },
  "minimum": 0.1,
  "maximumPerCall": 5,
  "roundUpTo": 0.000001
}
```
- `model.costShare`: 0 = the model's cost is not charged (default, as asked); 1 = passed through at cost; 1.2 = cost + 20%
  ChainAim margin. The raw model cost is always computed and shown, even when it is not charged.
- Flags/env override the path only (`--pricing-config` / `PRICING_CONFIG`), never single prices on the command line, so the
  quote, the paywall and the console always agree. The old PRICE_SCAN/MASK/CHAT stay as the fallback when no file is given.

### 3.2 One estimate function: `packages/pricing/src/estimate.ts` (pure, no I/O)
```ts
estimatePrice(pricing, work, model?) -> {
  fixed, data: { maskedFields, kbSent, rowsProcessed, actusCalls, amount },
  model: { id, inputTokens, outputTokensMax, rawCostUsd, charged }, total, currency, roundedTo, notes[] }
work = { flow, maskedFields, bytesSent, rowsProcessed, actusCalls, model, maxOutputTokens }
```
- inputTokens = ceil(bytesSent / charsPerToken) (an estimate, labelled as such); output = the max_tokens actually requested
  (the cap, so the quote is an upper bound and a call can never cost more than quoted).
- total = round_up(fixed + data + model.charged), clamped to [minimum, maximumPerCall]; above the maximum -> refused, not quoted.
- Used by: the paywall (to quote), the free quote route, the client scripts and the console (to show the price before
  paying and to check the buyer's spending ceiling).

### 3.3 Quote before paying, check after
1. The client masks (xrplh-9), then declares the work in one header:
   `X-ChainAim-Work: flow=crossask-answer;model=bedrock/nemotron-nano-3-30b;maskedFields=12;bytes=1830;rows=5000;actus=0;maxTokens=1024`
2. **Free quote**: `POST /v1/quote` (no payment) with the same header returns the breakdown JSON (§3.2). The UI and scripts show it.
3. **Paid call**: the paywall's DynamicPrice reads the header and quotes `estimatePrice(...).total` with a fresh invoice.
4. After payment and BEFORE settling, the paywall checks the body against the declaration: placeholders counted in the body
   >= maskedFields declared? (the server can see placeholders); body bytes <= declared; max_tokens <= declared; model = declared;
   ACTUS calls in the request = declared. A mismatch -> 402/400, nothing settled, nothing charged (same "never settle" rule as
   today [CODE app.ts]).
5. The receipt and the decision ledger record the breakdown (numbers only, no text).
- `rowsProcessed` is computed on the PC and cannot be verified by the server (the data never leaves). It is priced on trust
  and flagged as declared-only in the receipt; with costs at 0 this has no effect today.

### 3.4 ACTUS through ChainAim, so it can be priced
- New paid route `POST /v1/actus/eventsBatch` on the paywall -> forwards to the configured ACTUS server (or ACTUS Mentor
  /run-contract) with terms only; `actus=1` in the work header; price = fixed + perActusCall (+0 model).
- contract-cashflows.ts gets `--via chainaim` (pay per ACTUS call through the paywall) next to direct/mentor.

### 3.5 Every flow and what one paid call is
| Flow | Paid calls per user action | Work declared |
|---|---|---|
| Private chat (console 02, private-ask, e2e, buyer.ps1) | 1 chat call | masked fields, bytes, model, maxTokens |
| Agent (Strands) | 1 per tool call (already per call [CODE]) | same |
| Ask across files (console 03, ask.ts) | 2: query + answer (or 1 with "table only") | query: bytes of the schema; answer: masked fields + bytes of the result + rows processed |
| Contract cash flows | 1 read (model) + 1 ACTUS call per contract | masked fields, bytes, model; actus=1 |
| Scan/mask preview (console 01) | 0 (local, after xrplh-9) | — |
Open: one payment per user action (bundle) instead of per call — needs x402 "upto" or batch settlement; t54 support is
[ASSUME] not verified; per call first.

### 3.6 Who pays in the UI
Console calls need a buyer wallet: Crossmark (a pop-up per call: 2 for one cross-file question) or a local TestNet wallet the
console server signs with (backlog item "pay with local wallet", seed from the secrets folder, never in the browser). [DECISION]

## 4. Risks
- An estimate is an upper bound by design (max_tokens), so buyers may overpay the model part; with costShare 0 today it is 0.
- Declared work (rows) is unverifiable server-side; priced at 0 now.
- Two calls per question at 0.1 fixed = 0.2 RLUSD per cross-file question; buyer ceilings must allow it.
- Pricing file changes change quotes immediately; quotes already issued keep their invoice amount.

## 5. Build plan (after xrplh-9, test-first)
1. packages/pricing (estimate + config validation) + tests (defaults give 0.1; breakdown; clamps; rounding to 6 dp).
2. Paywall: --pricing-config, DynamicPrice from the work header, POST /v1/quote, the post-payment body check, ledger fields.
3. Paid ACTUS route + contract-cashflows --via chainaim.
4. Clients: declare work (terminal + console), show the quote, ceiling check, then pay.
5. Live: one paid call per flow on TestNet; seller balance up by exactly the quoted totals.

## 6. Decisions for the owner
1. Fixed cost per paid **call** (0.2 for a two-step question) or per **user action** (one 0.1 for the whole question)?
2. UI payer: Crossmark pop-ups, or a local TestNet wallet the console signs with?
3. Should the free quote route be public, or need the gateway key?
