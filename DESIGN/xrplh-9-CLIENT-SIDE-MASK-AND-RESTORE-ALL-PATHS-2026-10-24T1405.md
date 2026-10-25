# xrplh-9 — Client-side masking and re-substitution, the same on every path (UI and terminal)

Breadcrumb: DESIGN/README.md → xrplh-5 (masking fix) → xrplh-7 (zones / hosted) → **xrplh-9** (this).
Status: DESIGN, not built. Written 2026-10-24 14:05 (UTC-05:00) from the code as it is at commit 4148ddf (+ uncommitted CFO-2 fixes).
Legend: [CODE] read in this repo today · [ASSUME] not verified yet, a rig checks it first.

## 1. The rule (owner, 2026-10-24)
1. **Mask at the edge.** Every text leaves the user's PC only after masking on the PC. The ChainAim gateway, the paywall and every model see placeholders only.
2. **Restore at the edge.** Real values are put back only on the PC, from a map that never leaves the PC. The server never restores.
3. **The map lives where the masking happens**, in one local folder, and is put together with the answer outside the server.
4. **Same for every flow**: console tabs 01/02/03 and the paid chat; terminal private-ask, e2e, buyer.ps1, agent, ask.ts, contract-cashflows.ts; any model (local, OpenRouter, Bedrock).

## 2. What happens today [CODE]
| Flow | Masked on the PC? | Who restores | Raw text reaches the gateway? |
|---|---|---|---|
| Terminal paid ask: private-ask.ts, e2e-private-ask.ts, buyer.ps1 | yes, client-mask.ts `<C_TYPE_n>` | gateway restores its own `<TYPE_n>` (unless serverRestore off), client restores `<C_..>` | no (masked first); gateway may mask more |
| Terminal agent (Strands on Bedrock), F2 | yes, prompt-scan.ts (client patterns + local Presidio, fail closed, residual check) | client; serverRestore off option | no |
| Terminal ask.ts / contract-cashflows.ts (crossask) | **no** | **gateway** (restoreCompletion default) | **yes** (column names, code values, result rows, contract text) |
| Console 01 Scan and mask | **no** (that tab shows the gateway's own scan) | gateway returns the map to the browser | **yes** |
| Console 02 Private chat (unpaid) | **no** | nobody: chainaim_restore:false, placeholders shown (KEEP_PLACEHOLDERS) | **yes** |
| Console 02 paid (Crossmark) | **no** | gateway | **yes**, through the paywall |
| Console 03 Ask across files | **no** | **gateway** | **yes** |
Safe today only because the gateway runs on the same PC. With a ChainAim-hosted gateway, 5 of 7 flows would send raw text to ChainAim.

## 3. Design
### 3.1 One client privacy module, used by every client
`packages/privacy-client/src/` (TypeScript, no new dependencies; reuses paywall/scripts/client-mask.ts and prompt-scan.ts and the gateway's entities/residual checks, as prompt-scan.ts already does):
- `MaskSession` — one per conversation / question / document run.
  - `mask(text) -> masked`; `maskMessages(messages)`; **one map per session**, so the same value keeps the same `<C_TYPE_n>` across turns and across steps (query, answer, follow-up).
  - Detectors: `--client-scanner client|presidio|both` (default **both**: patterns + the local Presidio container, as F2). **Fail closed**: Presidio down or malformed -> refuse, nothing sent. Then the self-check (no detector finds anything left) and the residual check (long digit runs, phones, e-mails, titled names) on the masked text.
  - `restore(answer) -> { text, unresolved, leftovers }`: client-mask.ts restore (lenient, `dropPrefix` off because the server keeps its own `<TYPE_n>`). Server placeholders that remain (`<PERSON_2>`: something the gateway caught that the PC missed) stay visible and are counted; they cannot be restored anywhere, by design.
- `MapStore` — the mapping, on disk, next to the work:
  - Location: `<first allowedRoot>\_chainaim\maps\<session-id>.json` (e.g. `C:\PRIV-AI-DATA\_chainaim\maps\...`): the same local data root the data comes from; the `_*` folder is hidden from listings (data-sources hideFolders) and is outside every repo. Overridable with `--map-dir` (absolute path, refused inside a git repo).
  - Content: `{ sessionId, createdAt, flow, entries: { "<C_PERSON_1>": "Northline Apparel (demo)", ... } }`. No server data, no keys. Written atomically, owner-only permissions where the OS allows.
  - Retention: `--map-keep session|<days>` (default **session**: deleted when the run / console session ends; the console keeps maps in memory and writes them only with `--map-keep <days>`). [DECISION 2]
  - The map file is the "key to remap": a person can re-open an answer later and restore it only on this PC.
- The masked text, never the map, is what any log or ledger may show.

### 3.2 The server never restores
- Every ChainAim client sends `chainaim_restore: false` (already supported by the gateway [CODE]).
- New gateway flag `--server-restore allow|never` (default allow, for outside API users); all test-console modes and the hosted deployment set **never**: a request asking the server to restore is answered with placeholders anyway. Tested.
- The gateway keeps masking anything the client missed (defence in depth) and keeps its residual 422 check. Its own placeholders come back as they are.

### 3.3 Each flow, after the change
| Flow | Client edge (where masking + map + restore happen) |
|---|---|
| Terminal: private-ask, e2e, buyer.ps1, agent, ask.ts, contract-cashflows.ts | the script itself, on the PC (MaskSession in-process) |
| Console 01/02/03 and paid chat | **the console server** (`test-console/console/server.ts`, a local process on 127.0.0.1): it masks before forwarding to the gateway or paywall and restores before answering the browser. The browser never talks to ChainAim directly for text. |
| Paid chat (Crossmark) | the browser signs the RLUSD payment; the console server masks the body before relaying it with the payment header. The payment binds the invoice, not the body [CODE invoices.ts], so masking after signing does not break the payment. [ASSUME: confirm with one live paid run] |

Crossask specifics: query step — column names and code values are masked too (normally nothing to mask); answer step — result rows masked, the model words `<C_ORG_1> owes 177050.9`, restored on the PC; the number check runs on the restored answer against the real result. Contract reading — the contract text is masked (names, accounts), numbers and dates kept (client-mask does not touch amounts/dates); the terms check runs against the original document on the PC.

### 3.4 What the UI shows
Each answer: the restored answer (default), a toggle "what left this PC" (the masked text actually sent), counts per type, and "N server placeholders could not be restored" when the gateway caught something the PC missed. Tab 01 becomes "Mask on this PC" (client masking preview with the map shown locally) plus the gateway's residual check on the masked text.

## 4. Gaps and risks (critical)
1. **Local Presidio reachability.** prompt-scan.ts assumes `http://127.0.0.1:5002`; stack.ps1 publishes no Presidio port [CODE: only stub and paywall have -p]. Needed: `stack.ps1` publishes `127.0.0.1:5002` (localhost only). Without it the client must use `--client-scanner client` (patterns only: misses bare names; the gateway then catches them as server placeholders that cannot be restored).
2. **Client vs gateway detector drift.** Different detectors mean the gateway may still find things. Using the same Presidio image + the gateway's entity list on the client (as F2 does) keeps them aligned; the leftover counter makes drift visible.
3. **Over-masking** (company names as PERSON, amounts as PHONE) would now happen on the PC: safe, but answers get placeholder-heavy; the restore puts them back, so the user sees real values. The detector fixes (NEXT STEP 3) still matter for model quality.
4. **The map file holds real values.** Same sensitivity as the data next to it; never in a repo, never synced if the data root is not synced (data-sources notes already say keep it outside OneDrive). Encryption at rest is out of scope (Windows BitLocker covers the disk).
5. **Placeholder copying by small models** (seen 2026-10-24: a literal example copied). Instructions must not contain example placeholders; the restore counts unresolved ones.
6. **Third-party API users** of a hosted gateway that do not mask: allowed by `--server-restore allow` only on their own deployments; ChainAim's hosted gateway runs `never`.

## 5. Build plan (each step test-first; existing tests must stay green)
1. `packages/privacy-client` (MaskSession, MapStore) + tests: same value -> same placeholder across calls; map file location/content/cleanup; fail closed; leftovers counted.
2. Gateway `--server-restore never` + test; set in all modes.
3. Terminal: crossask (ask.ts, contract-cashflows.ts), private-ask/e2e/buyer.ps1 (move to MaskSession, serverRestore off), agent (already F2; switch to the shared module). A test per flow with a stub gateway that records bodies: **no original value in any body**.
4. Console server: mask/restore for /gateway/chat, /crossask, /paid/chat, tab 01; UI "what left this PC" toggle. Test with a stub gateway: browser-visible answer restored, gateway bodies masked.
5. stack.ps1: publish Presidio on 127.0.0.1:5002 (+ -Check line).
6. Live: all three models x tabs 02/03 + terminal ask/contract/private-ask; one paid run (confirms §3.3 assumption).
Estimate: ~3 new files, ~12 modified, ~25 new tests.

## 6. Decisions for the owner
1. Default client detector: **both** (patterns + local Presidio; needs gap 1 fixed) or client patterns only?
2. Map retention default: **session** (deleted at the end) or keep N days in `<root>\_chainaim\maps`?
3. Tab 01: replace the gateway scan demo with "mask on this PC", or keep both side by side?
