# xrplh-5 — chainaim-router-private-ai-2: final structure + masking fix + wallet reuse

Date: 2026-10-23 23:22 IST. Source repo: `PRIVAI2\chainaim-router-XRP` (read). Target repo: `github.com/chainaim-nisha/chainaim-router-private-ai-2` (new).
Inputs: xplh-4 chat (structure, tags-not-branches, S1–S5, dependency rule), "masking design" chat tonight (leak + gaps). xplh-3 was NOT re-read here; its decisions reach this file only through xplh-4 and `DESIGN/xplh-3-DESIGN-PLAN-reconciled.md` (not opened tonight).

Legend: **[READ]** verified in code tonight · **[CHAT]** from a prior chat, not re-read · **[ASSUME]** inference, verify before building.

---

## 1. The bug, precisely

### 1a. Verified leak (code path) [READ]
- `services/gateway/src/openrouter.ts` `PASSTHROUGH` includes `tools`, `response_format`, `stop`.
- `shapeBody()` copies those three **raw** into the model body.
- `chat.ts prepare()` only walks `v.messages` through `mapConversation` → Presidio. The three fields are never scanned.
- Effect: any personal value inside a tool description, JSON-schema description/enum/default, or a stop string reaches the model unmasked.

### 1b. Detection gaps [READ entities.ts]
- No bank-account type: `12-3456-7890123-00` matches nothing in `DETECTED_ENTITIES`.
- `LOCATION`, `DATE_TIME` deliberately excluded → street addresses and dates of birth pass.
- Names rely on Presidio NER only; titled all-caps names (`MR AB SAMPLEPERSON & MRS C SAMPLENAME`) have no backup rule. [ASSUME NER misses these — observed in tonight's masking chat, not re-tested.]
- Start-up canary covers name/email/MRN only [CHAT], so a broken new rule would not fail start-up.

### 1c. No fail-closed final check [READ chat.ts]
After masking nothing re-checks outgoing text; whatever detection missed leaves silently.

### 1d. Wallet: created every time, never reused [READ]
- `services/paywall/scripts/new-account.ts` calls `Wallet.generate()` each run, prints the seed, saves nothing.
- Agents then depend on a human pasting seeds into `.env` (`XRPL_SEED_T01_TESTNET`, …).
- [ASSUME] "wallet created and reused" = each agent/tenant wallet is created **once**, persisted securely, and loaded on every later run (no re-generate, no re-fund). The console's paid chat uses the visitor's own Crossmark wallet (`test-console/console/server.ts` relays `/paid/chat`), so nothing to persist there.

---

## 2. Guarantees the new repo enforces (each has a test)

| # | Guarantee | Where | Test |
|---|---|---|---|
| G1 | Every string leaf of every field that reaches a model is scanned: messages, tool-call args, **tools, response_format, stop** | `chat.ts`, `privacy/mask.ts`, `openrouter.ts` | `passthrough-mask.test.ts`: canary in a tool description, schema `description`, `enum`, stop string → spy sees only placeholders |
| G2 | Detection covers BANK_ACCOUNT, titled names, address, date of birth | `privacy/entities.ts` | `entities.test.ts` with bank-statement sample lines |
| G3 | Residual guard: after masking, a long digit run / email / phone / titled name left → 422, nothing sent, ledger records kinds+counts only | `privacy/residual.ts`, `chat.ts`, `main.ts` | `residual.test.ts` + chat test asserting zero upstream calls |
| G4 | Start-up canary covers every new type; gateway refuses to start otherwise | `privacy/presidio.ts` | `presidio.test.ts` |
| G5 | Tool **names** never altered; a personal value in a tool name → 400 | `chat.ts` | test |
| G6 | End-to-end: spy stand-in shows no canary from `rig/tenants/*/docs` or `test-console/samples` | `prechecks/r16-leak` | PASS/FAIL |
| G7 | Wallet ensure is idempotent: second run returns same address, no second funding tx, seed never printed | `packages/signer` | `prechecks/r17-wallet-reuse` |

---

## 3. Code for the fix (gateway keeps zero npm runtime deps)

> Status: written against files read tonight, **not yet run**. §6 runs tests before any tag.

### 3a. `privacy/mask.ts` — walker for request fields
```ts
/** Request fields that reach the model besides messages; walked like tool-call arguments (keys then values). */
export const SCANNED_REQUEST_FIELDS = ["tools", "response_format", "stop"] as const;
export type ScannedFields = Partial<Record<(typeof SCANNED_REQUEST_FIELDS)[number], unknown>>;
export const TOOL_NAME_CONTEXT = "\u0000tool_name";

export function mapRequestFields(raw: Readonly<Record<string, unknown>>, fn: TextMapper): ScannedFields {
  const out: ScannedFields = {};
  for (const f of SCANNED_REQUEST_FIELDS) {
    if (raw[f] === undefined) continue;
    out[f] = f === "tools" && Array.isArray(raw[f]) ? (raw[f] as unknown[]).map((t) => mapTool(t, fn)) : mapJson(raw[f], "", fn);
  }
  return out;
}
function mapTool(t: unknown, fn: TextMapper): unknown {
  if (typeof t !== "object" || t === null || Array.isArray(t)) return mapJson(t, "", fn);
  const { function: f, ...rest } = t as Record<string, unknown>;
  if (typeof f !== "object" || f === null || Array.isArray(f)) return mapJson(t, "", fn);
  const { name, ...fnRest } = f as Record<string, unknown>;
  const outName = typeof name === "string" ? fn(name, TOOL_NAME_CONTEXT) : name; // caller refuses if changed (G5)
  return { ...(mapJson(rest, "", fn) as object), function: { name: outName, ...(mapJson(fnRest, "", fn) as object) } };
}
```
(`mapJson` already exists in this file and is reused.)

### 3b. `chat.ts` — validate counts + scan with the same Masker
- `validateChat`: also run `mapRequestFields(body, …)` to add its segments/chars to `MAX_CHAT_SEGMENTS` / `MAX_CHAT_CHARS`.
- `prepare()`:
```ts
const reqSegs: { text: string; context: string }[] = [];
mapRequestFields(v.raw, (text, context) => { reqSegs.push({ text, context: context === TOOL_NAME_CONTEXT ? "" : context }); return text; });
const all = [...segments, ...reqSegs];
const found = await deps.presidio.analyzeAll(all.map((s) => s.context + s.text), signal);
const entities = found.map((f, i) => withinValue(all[i].text, f, all[i].context.length));
const msgEntities = entities.slice(0, segments.length), reqEntities = entities.slice(segments.length);
// classify over ALL entities (request fields can make a request PHI too)
const masked = mapConversation(v.messages, (text) => masker.mask(text, msgEntities[next++]));
let k = 0;
const maskedFields = mapRequestFields(v.raw, (text, context) => {
  const out = masker.mask(text, reqEntities[k++]);
  if (context === TOOL_NAME_CONTEXT && out !== text) throw new HttpError(400, "a tool name contains a personal value; rename the tool");
  return out;
});
const hits = residualHits([...collectTexts(masked), ...collectLeaves(maskedFields)], deps.chat.residual);
if (hits.length) { record.residual = hits; throw new HttpError(422, `masking left ${hits.reduce((n, h) => n + h.count, 0)} possible identifiers (${hits.map((h) => h.kind).join(", ")}); nothing was sent and you were not charged`); }
```
- `Prepared` gains `maskedFields`; `callChain` passes it to `shapeBody`.
- `taskInput` uses `JSON.stringify(maskedFields.tools)` for `toolChars` (length only today, but keep everything masked-only).
- `ChatRecord` gains `residual?: ResidualHit[]` (kinds+counts, never values) — also add to S2 call-log schema.

### 3c. `openrouter.ts shapeBody()` — never copy the three fields raw
```ts
export function shapeBody(request: Readonly<Record<string, unknown>>, messages: readonly unknown[], maxTokens: number, masked: ScannedFields): Record<string, unknown> {
  const body: Record<string, unknown> = { messages, max_tokens: maxTokens };
  for (const field of PASSTHROUGH) {
    if (request[field] === undefined) continue;
    body[field] = Object.hasOwn(masked, field) ? masked[field as keyof ScannedFields] : request[field];
  }
  return body;
}
```
Remaining PASSTHROUGH fields are numbers/booleans/enums. `tool_choice` may name a function: only allowed if it names a tool that passed G5 (else 400).

### 3d. `privacy/residual.ts` (new)
```ts
/** Post-mask check. Reports kinds and counts, never values. Placeholders and [CARD REMOVED] are removed first. */
export type ResidualPolicy = { enabled: boolean; minDigits: number; email: boolean; phone: boolean; titledName: boolean };
export type ResidualHit = { kind: "digits" | "email" | "phone" | "titled_name"; count: number };
const PLACEHOLDERS = /<\s*[A-Za-z][A-Za-z_]*?_\d+\s*>|\[CARD REMOVED\]/g;
export function residualHits(texts: readonly string[], p: ResidualPolicy): ResidualHit[] {
  if (!p.enabled) return [];
  const rules: [ResidualHit["kind"], RegExp, boolean][] = [
    ["digits", new RegExp(`(?:\\d[ -]?){${p.minDigits - 1}}\\d`, "g"), true],
    ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, p.email],
    ["phone", /\+?\d[\d ()-]{8,}\d/g, p.phone],
    ["titled_name", /\b(?:MR|MRS|MS|MISS|DR|SHRI|SMT)\.?\s+(?:[A-Z][A-Za-z'-]*\s*){1,3}/g, p.titledName],
  ];
  const counts = new Map<ResidualHit["kind"], number>();
  for (const t of texts) {
    const clean = t.replace(PLACEHOLDERS, " ");
    for (const [kind, re, on] of rules) if (on) counts.set(kind, (counts.get(kind) ?? 0) + (clean.match(re)?.length ?? 0));
  }
  return [...counts].filter(([, n]) => n > 0).map(([kind, count]) => ({ kind, count }));
}
```
Known tradeoff: digit runs ≥ `minDigits` in legitimate content (unformatted totals, long IDs the user wants analysed) will be refused. Tune with `--residual-min-digits`; never pass silently.

### 3e. `privacy/entities.ts` additions
- `BANK_ACCOUNT` ad-hoc recognizer: `\b\d{2}-\d{4}-\d{7}-\d{2,3}\b` (score 0.6, format seen in the sample) and `\b\d{9,18}\b` (score 0.1 + context `account, acct, a/c, ac no, iban, ifsc, bsb`). Add to `PERSONAL_ENTITIES`.
- Titled-name `PERSON` pattern recognizer (`MR|MRS|MS|DR|SHRI|SMT` + 1–3 capitalised tokens, score 0.6).
- `LOCATION` added to `DETECTED_ENTITIES` + `STREET_ADDRESS` pattern (house number + street word) → masked. Behind `--mask-location`.
- `DATE_OF_BIRTH`: date pattern + context `dob, date of birth, born` (0.1 + context) → masked. Other dates stay (model needs transaction dates). Behind `--mask-dob`.
- `REQUIRED_PRESIDIO_ENTITIES` add `LOCATION` when `--mask-location on`.
- Placeholder collision rule (Algo_x402 chat): client masks use `<C_TYPE_n>`, server `<TYPE_n>`. Keep it.

### 3f. `privacy/presidio.ts` canary + `main.ts` flags
Canary gains an account number, a titled all-caps name, an address; expected types updated.
New flags (defaults): `--residual-guard on|off` (on) · `--residual-min-digits N` (9) · `--residual-email on|off` (on) · `--residual-phone on|off` (on) · `--residual-titled-name on|off` (on) · `--mask-location on|off` (on) · `--mask-dob on|off` (on).
[ASSUME] `main.ts` uses `parseArgs`; read before editing.

### 3g. Wallet: create once, reuse — `packages/signer`
```
node packages/signer/cli.ts ensure --alias t01 --network testnet|mainnet
     [--store DIR]            default %USERPROFILE%\.chainaim\wallets  (outside every repo / OneDrive / Claude folders)
     [--fund faucet|none]     default faucet on testnet, none on mainnet; funds only when the account is NEW
     [--signer local|kms]     default local
     [--kms-region R] [--kms-alias-prefix P]
node packages/signer/cli.ts show --alias t01 --network testnet    # address + XRP/RLUSD balance; never the seed
node packages/signer/cli.ts list [--store DIR]
```
- `local`: `<store>\<alias>.<network>.json` exists → decrypt & load. Else `Wallet.generate()`, encrypt seed with AES-256-GCM, key = `scrypt(CHAINAIM_WALLET_PASSPHRASE, salt)` (Node `crypto` only), write with `flag: "wx"` (never overwrite), then fund once. Passphrase from env only; missing → refuse.
- `kms`: alias = KMS key alias; ensure = DescribeKey, create only if missing (ED25519, per the L2 plan [CHAT]). Same `XrplSigner` interface as `services/paywall/scripts/signer.ts` [CHAT, not re-read].
- `xrpl-payer` `pay.ts` / `rig.ts` gain `--wallet-alias A --wallet-store DIR`; `--signer seed` keeps env seeds as fallback.
- `services/paywall/scripts/new-account.ts` → shim that calls `ensure` (old command still works, stops making throwaway wallets).

---

## 4. Final structure — `chainaim-router-private-ai-2`

```
chainaim-router-private-ai-2/                      private; main + annotated tags (xplh-4 rule)
├─ PROJECT_CONTEXT.md        MOD   + G1–G7, extractor, wallet store location
├─ package.json              MOD   npm workspaces: packages/*, services/*, hack/{pages,control-room,lending,flows,data-gen}
├─ .gitignore                MOD   + prechecks/logs, hack/.env, **/wallets/, config/data-sources.json, local-gateway-key.txt
├─ config/                   (copied) + column-policy.json NEW, demo-cast.json (S4)
├─ packages/
│  ├─ route-engine/          (copied, unchanged)
│  ├─ schemas/               NEW  S1 tool-api · S2 call-log (+residual kinds) · S3 lending-evidence · S4 cast-networks · S5 signer
│  ├─ client-privacy/        NEW  OPEN  ← paywall/scripts/client-mask.ts (shim left); <C_TYPE_n>; same residual rules as gateway
│  ├─ xrpl-payer/            NEW       ← paywall/scripts/pay.ts + xrpl.ts (shims left); --wallet-alias
│  ├─ signer/                NEW       S5 interface · local (encrypted store, ensure) · kms · cli.ts (§3g)
│  └─ attestation-verify/    NEW  OPEN
├─ services/
│  ├─ gateway/               MOD  chat.ts, openrouter.ts, main.ts, privacy/{entities,presidio,mask}.ts
│  │                              privacy/residual.ts NEW · privacy/structured.ts NEW (CSV/TSV/JSON column policy)
│  │                              test/{passthrough-mask,residual,entities}.test.ts NEW
│  ├─ extractor/             NEW  any file → text only (PDF text layer, OCR for scans/images, docx/xlsx); 127.0.0.1; no masking
│  ├─ presidio/              MOD? Dockerfile: larger English NER model [ASSUME; not read]
│  ├─ paywall/               (copied) scripts/ keep shims
│  ├─ analyst/               (copied, unchanged; never calls a model [CHAT])
│  ├─ web/                   (copied, UI unchanged) Crossmark page, wallet.js bundle
│  └─ tools-mcp/             NEW  pay, mandates, limits, Mentor failover, writes S2
├─ test-console/             (copied; every current tab kept) MOD server.ts: /extract relay (--extractor URL);
│                                  index.html: masked preview before Send (shows exactly what the model gets)
├─ prechecks/                NEW  r01…r15 (xplh-4) + r16-leak (G6) + r17-wallet-reuse (G7) + check-boundaries.ps1
├─ hack/                     NEW  Saturday-only: flows/ strands/ lending/ pages/ control-room/ data-gen/ .env.example
├─ deploy/                   NEW  docker-compose.local.yml (127.0.0.1 binds), up.ps1, health.ps1
├─ scripts/ eval/ docs/ rig/ (copied)
└─ DESIGN/                   (copied) + this file
```
Dependency rule (xplh-4): `hack/ → packages/*` by import, `→ services/*` by URL/MCP only; `services/* → packages/*` only; nothing imports `hack/`.

## 5. Saturday 9 AM ET carve-out
| To the public submission repo | Stays private here |
|---|---|
| `hack/*` as-is (imports package names only) | `services/*` |
| `packages/{schemas, client-privacy, attestation-verify}` pinned at `chainaim-open v0.1.0` | `packages/{signer, xrpl-payer, route-engine}` |
| `hack/.env.example` → private service URLs | wallet store, keys, `.env`, data folders |
| README: pre-existing vs built at the event | `prechecks/fixtures/recorded` |
Submission pins infra to tag `pre-hack-final` of this repo.

## 6. Build order (tests green before each tag)
1. Seed new repo from old with history → tag `v0-import`. (manual)
2. §3a–3d (G1, G3, G5) + tests → `npm test` → tag `fix-g1-g3`.
3. §3e–3f (G2, G4); rebuild `chainaim-gateway:test`, recreate `ca-gateway` → tag `fix-g2-g4`.
4. r16-leak against the spy with bank-statement + prescription samples → tag `rig-r16-pass`.
5. §3g signer + r17 → tag `rig-r17-pass`.
6. Skeleton moves (schemas, client-privacy/xrpl-payer with shims, prechecks, hack, deploy) → tag `skeleton`.
7. Extractor + console relay + masked preview → tag `extractor`.
8. Friday night → `pre-hack-final`.

## 7. Read before editing (not yet read)
`services/gateway/src/main.ts`, `privacy/presidio.ts`, `privacy/classify.ts`, `services/gateway/Dockerfile`, `services/presidio/Dockerfile`, `test-console/console/index.html`, `services/paywall/scripts/{signer,pay,rig}.ts`, `test/chat.test.ts` + `test/helpers.ts` (to match test style), `DESIGN/xplh-3-DESIGN-PLAN-reconciled.md`.
