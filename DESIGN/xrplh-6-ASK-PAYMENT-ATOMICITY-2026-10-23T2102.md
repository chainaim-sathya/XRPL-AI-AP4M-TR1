# xrplh-6: How a paid private ask and its payment are tied together (and the gaps)

Written 2026-10-23 21:02 (UTC-05:00) = 2026-10-24 02:02 UTC. Status: **analysis done, fix NOT started** (owner decision; needs an ARCH-ID).

## Breadcrumb (start here when you come back)

- Repo: `chainaim-router-private-ai-2` (remote `private2`).
- Flow code read for this note:
  - `services/paywall/src/app.ts`: `createPaywall` (replay guard `onBeforeVerify`, payment log `onAfterSettle`, `proxy()` tied to the caller's connection, capacity guard before the payment middleware).
  - `services/paywall/node_modules/@x402/hono/dist/esm/index.mjs`, lines ~236-330 (`@x402/hono` payment middleware, case `payment-verified`): runs the handler, cancels on `status >= 400`, buffers the body, calls `processSettlement`, releases the body only on success, replaces it with an error on failure.
  - `services/paywall/src/invoices.ts` (`InvoiceBook`: one invoice, one presentation).
- Tests that pin the current behaviour (services/paywall, `npm test`): "never settles a paid call that the gateway refuses"; "never settles a paid call whose caller hangs up before the gateway answers"; "settles a served call, returns the receipt..."; ARCH-014 replay tests; "the capacity guard ...".
- Live evidence, 2026-10-24 (BUILD_LOG.md): run 01:38Z gateway 422 -> no answer, balances unchanged (no charge); runs 00:40Z, 01:28Z, 01:43Z answer + settled, buyer -0.01 / seller +0.01.
- End-to-end check that detects a mismatch: `services/paywall/scripts/e2e-private-ask.ts` (VERDICT compares HTTP/answer with ledger balances).

## 1. The steps (x402 "exact" scheme, RLUSD on XRPL)

1. Client asks; paywall answers **402** with the quote (0.01 RLUSD, pay-to, invoice id).
2. Client **signs** an XRPL Payment for exactly that quote. It is **not submitted** to the ledger.
3. Paywall **verifies** the signed payment through the t54 facilitator; `onBeforeVerify` claims the invoice once (replay guard).
4. Paywall forwards the (masked) ask to the gateway (`proxy()`); gateway masks, the model answers, gateway restores its own placeholders.
5. Gateway status **>= 400** -> middleware cancels: **never settled**, caller not charged.
6. Status **< 400** -> the answer is **held (buffered)**; the paywall asks the facilitator to **settle** (submit the payment).
7. Settle **succeeds** -> answer + receipt (PAYMENT-RESPONSE) released. Settle **fails** -> answer **discarded**, caller gets a payment error.

## 2. Can one happen without the other?

**Answer without payment: no (by design).** The answer is released only after a successful settle (step 7). Cost of a failed settle falls on the operator (the model already ran).

**Payment without answer: normally no.** Guards:

| Case | Result | Where |
|---|---|---|
| Gateway refuses (400/422/503...) | cancelled, not settled | middleware `status >= 400` |
| Caller hangs up before the gateway answers | gateway call aborted -> 502, not settled | `app.ts` `proxy()` signal includes `c.req.raw.signal` |
| Chat cannot be served now | no price shown | capacity guard before payment middleware |
| Same payment presented twice | refused | `onBeforeVerify` + `InvoiceBook` (ARCH-014) |

## 3. The issue: two narrow windows where the buyer pays and gets no answer

(From reading the code; not yet observed in a run.)

- **W1. Caller disconnects after the answer is ready, during settlement.** Settlement does not check whether the caller is still connected; the payment settles and the buffered answer has nobody to go to.
- **W2. Facilitator settle call fails or times out after it actually submitted the payment.** The transaction can validate on the ledger while the paywall turns the facilitator error into an error response (middleware catch: `FacilitatorResponseError` -> error response; anything else -> 402) and drops the answer.

In both, the buyer **cannot fetch the answer again**: the replay guard refuses the same payment, and the answer is not stored.

## 4. The fix (proposed)

1. **Settled-answer store (short-lived).** After a successful settle, keep the answer for N minutes (flag `--answer-ttl-sec`, default e.g. 600), keyed by invoice id, encrypted at rest or memory-only; never logged. Holds only what the buyer already received (masked by the gateway, client placeholders intact), so no new data exposure. Bound its size (flag `--answer-store-max`).
2. **Collect route.** `GET /v1/receipts/{invoiceId}/answer` (or re-presenting the same PAYMENT-SIGNATURE): returns the stored answer once, only to a caller who proves payment (the signed payment's transaction hash on the ledger to this pay-to for this invoice). Refuse otherwise.
3. **Ledger check on settle failure (W2).** When the facilitator call errors, look up the payment's transaction on the ledger (by hash from the signed blob) before discarding: if it validated with tesSUCCESS to pay-to for the quoted amount, treat it as settled -> release the answer (and store it per 1).
4. **Client side.** `private-ask-core.ts` / `e2e-private-ask.ts`: on a lost response or a settle error, read the transaction hash it signed, check the ledger, and if paid call the collect route. The E2E VERDICT gains a check "paid => answer received (directly or collected)".
5. **Tests (test-first).** Stub facilitator that settles then errors (W2); a caller that aborts after the gateway answered (W1); collect route refuses without proof, serves once with proof, expires after TTL; nothing about the answer reaches the payment log.

Trade-offs: the store keeps answers for minutes (memory, a bounded privacy surface); the ledger check adds one read on a rare path; the collect route is a new public endpoint (needs rate limiting and the same body/headers rules).

## 5. Open

- No ARCH-ID yet (no architecture.md); the fix needs one.
- Decide TTL, memory-only vs encrypted disk, and whether collect is by invoice id or by re-presenting the payment.
