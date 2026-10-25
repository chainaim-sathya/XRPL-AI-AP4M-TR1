# xrplh-14 — "Why Not" track: ChainAim as-is + an admin control room fed by QuickNode

Breadcrumb: xrplh-11 (Agentic Finance) · xrplh-12 (Lending) · xrplh-13 (session record) · **xrplh-14** (this).
Status: **DESIGN ONLY — no code written or changed.** Written 2026-10-24 19:55 (UTC-05:00).
Tags: [WEB] read this session · [CODE] this repo · [CHAT] past chat · [ASSUME] not verified — check named.

## 0. Bottom line
- Keep the app exactly as it is (XRPL **Testnet**, x402 + t54, RLUSD, private chat). Add one thing: an **admin control room**
  that watches the buyer and seller wallets through **QuickNode** and keeps running totals of RLUSD collected for private inference.
- **USP: "Private for the user, provable for the business."** Nobody running the gateway can read a prompt, yet anyone can audit
  the gateway's revenue from the public ledger — and the control room proves the two books agree.

## 1. Facts this rests on
| Fact | Source |
|---|---|
| Tracks: Agentic Finance; Lending & Borrowing; Protocol Innovation; **Why Not = open lane** | [CHAT xplh-3, XRPL research] |
| QuickNode named among mentor/judge organisations | [CHAT XRPL research; not re-checked today] |
| QuickNode XRPL: **Mainnet and Testnet** (no Devnet); products "XRPL JSON-RPC", "WebSocket Subscriptions", "Streams", "Webhooks" (subscribe to addresses / event types) | [WEB quicknode.com/chains/xrpl, today] |
| Paywall writes one `payment_settled` JSON line per settled payment: ts, route, amount, asset, network, payer, transaction (no body, no decision id) | [CODE services/paywall/src/app.ts] |
| Balance reader exists: `account_info` (XRP) + `account_lines` with the RLUSD issuer (RLUSD) | [CODE services/web/src/balance.ts] |
| Earlier plan already had a "seller wallet meter via Quicknode" panel and rig R2 `quicknode.ts --ws-env QUICKNODE_WS_TESTNET` (not started) | [CODE DESIGN/codebase-review-and-iteration-plan.md, xplh-3-DESIGN-PLAN-reconciled.md] |
| Wallets (Testnet, public): seller/payTo `rn5hSy7QvsrQLpGb3k5dp4h8Yrk9J7gBej`; buyer B01 `racuvQQJSCD2YUxR5qLstLBfbCkxj53dcU`; tenants t01 `rNyKVsrK82yU4v5WBxfAjq3Nk7Ls9oVF8U`, t02 `rD59tmENJNnHovdi4hKq79DVP4gnDNFGWk`, t03 `rKSZJdBpp1vDpqYWbaDFKWDecwSMmmGA1B`; RLUSD issuer `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV` | [CODE STATE.md, BUILD_LOG.md] |

## 2. What the control room shows (one page)
| Panel | Data | From |
|---|---|---|
| 1 Seller meter | RLUSD collected: today / session / all-time, payments per minute, last 10 payments with explorer links | QuickNode WS `subscribe accounts:[seller]` + `account_tx` backfill |
| 2 Buyers | Per buyer: RLUSD spent, payments, XRP fee burned, remaining balance, trust line open | QuickNode WS + `account_info` / `account_lines` |
| 3 Two books agree | Paywall log vs ledger: matched / only-in-log / only-on-ledger, by tx hash and amount | `payment_settled` lines ⨝ ledger Payments |
| 4 By service | RLUSD per route (scan, mask, chat, private-ask) | paywall log route + matched tx |
| 5 Privacy badge | "0 prompt bytes stored" — the panel reads only money and routes; gateway decision ledger holds counts, never text | [CODE PROJECT_CONTEXT constraints] |

Counting rule (deterministic): a payment counts only if it is a **validated** `Payment`, `TransactionResult = tesSUCCESS`,
`delivered_amount` currency RLUSD (`524C555344000000000000000000000000000000`) from the configured issuer, destination = a watched
address. Partial payments are counted by `delivered_amount`, never `Amount`. XRP fee from `Fee` (drops ÷ 1e6).

## 3. Architecture (smallest change)
```
QuickNode XRPL Testnet ──WS subscribe(accounts)──▶ watcher (new, Node built-ins + ws) ──▶ in-memory totals + JSONL snapshot
        └──JSON-RPC account_tx / account_info / account_lines (backfill, balances)
paywall payment log (payment_settled lines) ─────────▶ reconciler (pure function: join by tx hash)
                                                       └──▶ test-console: new tab "04 Control room" (existing console/server.ts serves it)
```
- Lives in the existing **test-console** (new tab) so the app itself is untouched; watcher module `test-console/console/watch-ledger.ts`
  [ASSUME file layout — confirm against console/server.ts before building].
- Reuses `balance.ts` logic with the QuickNode URL instead of the public node.
- QuickNode endpoint URL contains a token → **env var only** (`QUICKNODE_WS_TESTNET`, `QUICKNODE_HTTP_TESTNET`), never in config or git.
- Optional: QuickNode **Webhooks** for an alert ("payment to seller ≥ X" / "buyer below Y RLUSD") — stretch.

Flags (defaults): `--quicknode-ws-env QUICKNODE_WS_TESTNET`, `--quicknode-http-env QUICKNODE_HTTP_TESTNET`,
`--seller rn5h…` (or `--seller-from-paywall http://127.0.0.1:8080`, as balances.ts already does), `--watch label=rADDR` (repeatable),
`--issuer rQhWct…`, `--backfill-ledgers 20000`, `--paywall-log <path>` (default: docker logs of ca-paywall via a file export),
`--snapshot-file`, `--fallback-public-node off` (on = use the public Testnet node if QuickNode is down, shown in the UI).

## 4. Why it fits "Why Not"
- Open lane rewards a sharp idea done well. The idea: **why not make an AI business that can't see your data but can't hide its revenue?**
- It is a new use of the ledger as a **public audit log for a privacy service**: the operator's claims (paywall log) are checked against
  the chain (QuickNode) in real time; any mismatch is visible.
- Built on what already runs live (30 settled payments from 3 tenants, e2e runs with 10/10 verdicts [CODE BUILD_LOG]), so the demo is real,
  not mocked.
- Sponsor fit: QuickNode used for the thing it is best at (subscriptions + backfill); a QuickNode sponsor prize was not verified — check.

## 5. Highlights
1. Live revenue meter for private inference, per tenant and per service, in RLUSD.
2. "Two books agree" reconciliation — the strongest visual: every paid call has a ledger tx, every ledger tx has a paid call.
3. Spend view per buyer matches the agent's own ceiling (`--max-spend`) — operator and customer see the same number.
4. Zero content in the admin view, by construction.
5. One-click explorer proof for any row.

## 6. 3-minute demo
0:00 problem (private AI must still be accountable) · 0:20 control room idle, totals from backfill · 0:40 run `rig.ts --calls 5` (3 tenants)
· 1:10 meter ticks live, buyers' spend rises, "two books agree" stays green · 1:50 show a row on the explorer · 2:10 show what the gateway
stores (counts, no text) · 2:40 close: private for users, provable for the business.

## 7. Work split
AI can do: watcher, reconciler (+ tests over recorded ledger JSON), control-room tab, flags, docs.
Manual: create a QuickNode XRPL **Testnet** endpoint; put its WS and HTTP URLs in the env file outside git; confirm whether QuickNode
runs a prize; run the live demo.

Open questions: (1) Read the paywall log from a file export or from `docker logs`? (2) Include the AP4M EVM wallets too (QuickNode
XRPL product does not cover XRPL EVM — would need a separate EVM endpoint [ASSUME]).
