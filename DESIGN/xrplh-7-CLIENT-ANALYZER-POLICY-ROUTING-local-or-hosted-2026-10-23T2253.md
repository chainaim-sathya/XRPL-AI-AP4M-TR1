# xrplh-7: client analyzer -> policy -> gateway routes local or hosted (free open-weight, e.g. Nemotron)

Written 2026-10-23 22:53 (UTC-05:00) = 2026-10-24 03:53 UTC. Status: **design only; no code**. Needs an ARCH-ID.
Tags: [CODE file:line] read in this repo today · [CHAT x] from a past chat (search snippets, not the full file) ·
[DOC] a doc in this repo · [INFER] my reasoning · [CHECK] must be verified before building.

## 0. Sources and limits
| Source | Status |
|---|---|
| `FINAGENTS\DESIGN\xrplh-4-PROJECT-STRUCTURE-and-REFACTOR-2026-10-23T1214.md` | **read 2026-10-23 23:05** [X4-STRUCT]: target tree, dependency rule, refactor steps |
| `...\xrplh-4-WORKPLAN-2PERSON-REPOS-DATA-LATENCY-2026-10-23T1110.md` | read [X4-WORK]: data locations (`C:\SATHYA\CHAINAIM3003\private-data\`, `...\demo-data\`, never in git; add both to `allowedRoots`), contracts C1-C5 (C1 includes `/v1/private/ask`), latency budget (T0 ms; <= 400 output tokens; <= 10 s p95 per action) |
| `...\xrplh-4-PRIORITIZED-WORKLIST-P1-P2-2026-10-23T1155.md` | read [X4-LIST]: locked decisions (open client = mask, leak gate, canary, verifier; private = gateway, paywall, router); Bedrock Nemotron 3 Nano / Gemma 3 4B on masked text (R5) |
| `...\xrplidea3-data-classes-jurisdiction-2026-10-22T1727.md` | **read in full** [IDEA3-CLASSES]: classes table with default policies, jurisdiction sources, policy-table fields, DPV alignment, who detects what, code changes |
| `...\xrplidea3-answerability-preflight-duckdb-2026-10-22T1117.md` | read (headings + key lines) [IDEA3-ANSWER]: schema adapters (YAML, fingerprint), intent catalog, DuckDB checks, verdict object, client flags |
| `...\xrplh-3-session-log-FULL-...1419IST.md`, `xrplh-3-full-session-log-...1412IST.md` | read (index): points to the xrplidea3 files above; Jev skip covers every sensitive class |
| Chainaim-router-restructure-1 chat | snippets [CHAT r1]: tree refined (`packages/schemas`, `client-privacy`, `extractor`, console masked preview, prechecks r16/r17) |
| "restructure-2" | = this session, "restructure-sathya-cont-2" (owner, 23:02): BUILD_LOG.md 2026-10-24 entries M1d..H1 |
| xplh-3 chat + `xrplidea3-CONSOLIDATED-router-privacy-classifiers-2026-10-22T1809.md` | file not in this repo; snippets [CHAT xplh-3]: client diagnostic layers L0-L3, `X-ChainAim-Preflight` header, classes, jurisdiction, DPV, "stricter never looser" |
| `DESIGN/xplh-3-DESIGN-PLAN-reconciled.md` | read [DOC]: L1 pipeline, §10 rows/latency, §11 policy, §12 code gaps |
| Code read today | gateway catalog.ts, chat.ts, classify.ts, openrouter.ts, main.ts; paywall app.ts; private-ask-core.ts; console server.ts/index.html; analyst README |

## 1. Goal (owner, 2026-10-23)
The client analyses the **directory, the content and the query**, decides with policy whether a request may leave the
machine at all, and if it may go to a hosted model, sends **masked** text plus **hints** (sensitivity classes in general,
not only health; **jurisdiction** of where the query comes from). The gateway, as long as the model is **free and
open-weight** and the data is **masked and confirmed**, routes **local or hosted** per request, using the hints.
Questions that DuckDB can answer on the client are answered there with **no LLM**; otherwise only a **subset of rows or a
summary** goes to the model. Prove it by a run that actually lands on a free OpenRouter **Nemotron** light reasoning model.

## 2. What exists today (verified)
| Piece | Fact |
|---|---|
| Gateway model source | one per process: `--model-source catalog|openrouter-free` [CODE main.ts:24,120-121] |
| Zones | catalog type has `zone: local | private-cloud | public-api` [CODE catalog.ts:15-17,42,101]; **not used** by routing (no `zone` in select.ts/chat.ts) [CODE grep] |
| Catalog deployment key | `apiKeyEnv` per deployment (env var NAME) [CODE catalog.ts:32,125-126] -> an OpenRouter model can sit in a catalog [INFER] |
| Pinned model | a client-named model is tried alone; `chainaim/auto` lets the gateway rank [CODE chat.ts:284-291] |
| Data classes | single label `PHI|PCI|PII|none`; policy only PHI -> `dataCollection: deny` [CODE classify.ts:6,31] |
| OpenRouter data policy | deny-request refusals handled [CODE openrouter.ts:99] |
| Residual guard | refuses (422) text that still looks personal after masking (R2 fixed today) [CODE residual.ts] |
| Paywall headers | forwards only `authorization` + `content-type` to the gateway [CODE app.ts proxy()] -> a preflight header would be **dropped** [DOC §12.3] |
| Client masker | `services/paywall/scripts/client-mask.ts` (+ two other maskers: web, gateway) [CHAT xplh-4] |
| Client request | body hard-codes `model: "chainaim/auto"` [CODE private-ask-core.ts:97]; no hints sent |
| Console | data folder: "Whole folder" / "Pick files" from `config/data-sources.json` [CODE index.html:650-695]; model pick list from gateway `/v1/models`, `--default-model` [CODE index.html:558-587, server.ts:8-11] |
| Analyst (DuckDB) | CSV/TSV only; profile -> **recipe** (file kinds, column roles, flow = the "mappings") -> analyze -> **evidence pack** within a char budget -> verify numbers; never calls a model; 127.0.0.1 [DOC analyst README] |
| JSON data files | console accepts `.json` uploads [CODE index.html:231]; **analyst does not read JSON** (CSV/TSV) [DOC analyst README] |
| Free Nemotron on OpenRouter | listed: `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`, `nvidia/nemotron-3.5-lightning:free`, `nvidia/nemotron-3-super-120b-a12b:free`, `nvidia/nemotron-3-ultra-550b-a55b:free` [CODE config/free-models.json]; live availability/latency [CHECK with scripts/verify-openrouter.ts] |

## 2b. Decisions already made in the earlier design (now read; these bind 3.x)
**Classes and default policy** [IDEA3-CLASSES §3A]:
| Class | Detected by | Default policy |
|---|---|---|
| PHI | medical IDs; health term + person; contextual health question | deny data collection, ZDR, no outside classifier |
| PCI | card numbers | removed before sending; never restored |
| PII | personal identifiers | deny data collection (**new**; today PII allows collection [CODE classify.ts:31]) |
| FIN | accounts, balances, transactions, loans of a person/company; contextual finance question | deny data collection, ZDR |
| CONF | contract/deal terms, pricing, tenant invoices (adapter-declared or contextual) | no frontier unless the tenant allows |
| SECRET | API keys, passwords, private keys, seeds | **refuse**, never send |

**Jurisdiction** [IDEA3-CLASSES §3B]: tenant declaration -> data adapter (e.g. GOBL `$regime`) -> entity types (Aadhaar/PAN/IFSC -> IN; SSN -> US; IBAN -> EU ...) -> addresses / phone codes / currency. Multi-valued.

**Policy table (config)** [IDEA3-CLASSES §3C]: `(class x jurisdiction) -> {data_collection, zdr, region, outside_classifier, frontier_allowed, enclave_required, local_only}`; applied policy = **strictest over all labels**; named-regime rows (HIPAA, PCI DSS, GDPR, India DPDP, GLBA) need legal review. Server: classes = union(client >= threshold, server detection, tenant default) [IDEA3-CLASSES §5]. Pipeline: detector entity -> DPV category + jurisdiction -> ChainAim class -> policy [§5b].

**Who detects what** [IDEA3-CLASSES §4]: client (before masking) = Presidio + patterns, local-LLM yes/no per class (`health_person`, `finance_person_or_company`, `confidential_business`), adapter+entities+tenant for jurisdiction, SECRET gate blocks locally; server = rescan + header + tenant default, no outside calls.

**Answerability** [IDEA3-ANSWER]: [A] schema adapters (YAML per schema, fingerprint on columns / `$schema`; ERPNext Sales Invoice + Payment Entry CSV/JSON; GOBL `bill/invoice` JSON via `read_json_auto` + `UNNEST`; unknown files -> generic profiler, user confirms the mapping once, saved as a new adapter) -> canonical finance views; [Q] intent catalog (question -> concepts, period, grain, joins, currency rule, params; rules first, local Ollama only when rules don't match, locally so it may see the unmasked question); [C] DuckDB checks (missing values, mixed currency, periods covered ...); **verdict** `{intent, verdict: ANSWERABLE|PARTIAL|..., reasons, tier: T0|T1|T2|TA, max_price_rlusd}`. Flags: `client preflight --tenant <dir> --question "..." --adapters config/adapters/ --intents config/intents.yaml --rules config/answerability.yaml --intent-parser rules|rules+local-llm --local-llm http://127.0.0.1:11434 --duckdb-sandbox strict --out preflight.json`.

**Hosted options already planned** [X4-LIST R5, xrplh-3 logs]: Bedrock Converse on masked text (Nemotron 3 Nano, Gemma 3 4B, us-east-1). OpenRouter free Nemotron (this note) is a second hosted zone; the same policy gates apply to both.

**Data** [X4-WORK §2]: private CSVs in `C:\SATHYA\CHAINAIM3003\private-data\`, synthetic in `...\demo-data\` (generator `data-gen`), both added to `allowedRoots`; never in git (pre-commit guard). **Latency** [X4-WORK §5]: T0 answers in ms (DuckDB, no model); <= 400 output tokens; <= 10 s p95 per on-stage action.

## 3. Target design

### 3.1 Placement (xplh-4 / restructure-1 structure)
```
packages/schemas/          NEW  preflight.schema.json, policy.schema.json, generated TS types   (S-series, P1)
packages/client-privacy/   NEW  mask (moved from paywall/scripts/client-mask.ts, shim left), leak gate,
                                diagnostics (L0), sensitivity, jurisdiction, tier, minimum-context, policy decision,
                                preflight builder   (OPEN package per xplh-4)
config/policy.yaml         NEW  one policy, read by client and gateway
services/gateway/          MOD  preflight intake, multi-label classes, policy + zone filter, mixed pool
services/paywall/          MOD  forward X-ChainAim-Preflight (content-free header)
services/analyst/          MOD  JSON files; per-question T0 answer; subset/summary export
test-console/              MOD  analysis panel, decision + masked preview, zone choice
prechecks/r18-hosted-nemotron/ NEW  live run lands on Nemotron within policy
```
Dependency rule unchanged: `services/* -> packages/*` only; `hack/ -> packages/*` by import, services by URL [CHAT xplh-4].

### 3.2 Client pipeline (per question)
1. **Intake**: files from the data folder (whole/pick) [CODE]; CSV/TSV + JSON via the analyst; PDF text via pdf.js (console) or the extractor (restructure-1, later).
2. **L0 deterministic diagnostics** (no model) [CHAT xplh-3]: structure, sizes, entity counts per type (bucketed), SECRET patterns (keys, tokens), identifier types.
3. **Sensitivity classes, multi-label**: PHI, PCI, PII, FIN, CONF, SECRET with a score each [CHAT xplh-3, DOC §11]. L0 rules first; optional L1 zero-shot NLI (Transformers.js) and L2 local Ollama, run **before masking, locally** [CHAT xplh-3]; thresholds favour recall.
4. **Jurisdiction**: (a) declared by the tenant/client config (`--jurisdiction IN|NZ|US|EU...`, "where the query comes from"); (b) inferred from identifier types (Aadhaar/PAN -> IN, NZ bank format -> NZ) [CHAT xplh-3]; send both; the stricter governs.
5. **Tier / answerability** [DOC §4, CHAT xplh-3]: T0 = DuckDB answers exactly on the client -> **no LLM, no payment**; T1/T2 = needs an LLM.
6. **Policy decision on the client**: `policy.yaml` (class x jurisdiction -> allowed zones, mask required, outside classifiers allowed). Outcomes: `local-only`, `hosted-allowed` (+ which hosted tier), `refuse`. Privacy escalations happen on the client, with nothing sent [DOC §4 L2].
7. **Minimum context** [DOC §10]: totals from DuckDB; or 1-3 example rows as a template; or <= N masked rows (start 50 rows / 12,000 chars); never whole files; the analyst's evidence pack is the default for folder questions.
8. **Mask -> leak gate** (exact-match of known values) -> **preflight header** -> pay -> send.

### 3.3 Preflight header (content-free) [CHAT xplh-3]
`X-ChainAim-Preflight: base64(JSON)`: `{v, client{name,version}, classes{PHI,FIN,...: score}, jurisdictions{declared, inferred},
tier, task_hint, zone_pref (local|hosted|any), allowed_zones (from client policy), masking{method, counts bucketed, leak_gate},
evidence{rows, chars}}`. Enums and buckets only, no values. Unsigned first; signing with the agent key later (KMS signer).

### 3.4 Gateway: policy-first routing
- **Mixed pool**: new `--model-source mixed` = catalog models (local Ollama, `zone: local`) **plus** hosted free open-weight entries (`zone: public-api`, adapter `openai`, `baseUrl https://openrouter.ai/api/v1`, `apiKeyEnv OPENROUTER_API_KEY`). Each hosted entry carries curated flags: `openWeight: true`, `free: true`, `dataCollection: allow|deny` [INFER; open-weight cannot be inferred from OpenRouter, it is curated].
- **Stricter, never looser** [CHAT xplh-3]: data classes = union(client claim, server detection); jurisdictions = union; allowed zones = intersection(policy(server classes, jurisdictions), client `allowed_zones`); `zone_pref` only ranks inside what is allowed.
- **Hard gates before any hosted call**: masking done, residual guard passed, model `openWeight && free`, class/jurisdiction allows the zone, PHI/"special category" -> local or `dataCollection: deny` only, SECRET -> refuse.
- **Rank** inside the allowed set: task fit (scores), latency class, availability/cooldown (exist), context length; fallback chain may cross zones only inside the allowed set (stability: hosted when local is slow/down, local when hosted is rate-limited).
- **Record**: ledger gets zone, policy rule id, preflight digest (no content); headers `x-chainaim-zone`, `x-chainaim-policy`.
- **Jev**: skipped when any class forbids outside classifiers [DOC §11].
- Flags: `--policy-file config/policy.yaml`, `--default-zone local`, `--allowed-zones local,public-api`, `--preflight required|optional|ignore`, `--hosted-timeout-ms`.

### 3.5 Nemotron as the light reasoning hosted default
Hosted entry `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` (and `nemotron-3.5-lightning:free` as alternative) [CODE free-models.json]. Reasoning models spend output tokens on thinking (seen with deepseek-r1 locally [DOC local-models.cpu.json notes]) -> set max output and timeout per entry. [CHECK] availability, latency, data-collection status and OpenRouter privacy settings with `scripts/verify-openrouter.ts` before choosing the default. Free tier ~50 requests/day without credits [DOC setup-end-to-end.md].

### 3.6 Clients
- Scripts: `private-ask-core.ts` builds the preflight, sends `model` (`--model`, default `chainaim/auto`), `--zone-pref`, `--jurisdiction`; e2e VERDICT adds "routed within policy" (zone allowed, model is the one requested or within allowed set).
- Console: analysis panel (profile/recipe/analyze/evidence exist via the analyst routes [CODE server.ts:126,349-353]) + decision card (classes, jurisdiction, tier, local/hosted/refuse, reason) + **masked preview before Send** [CHAT r1] + zone choice; T0 answers shown without paying.

## 4. Files to change (estimate from the code read; counts are per file)
| # | Functionality | New | Modified | Files |
|---|---|---|---|---|
| A | Schemas + policy | 5 | 0 | packages/schemas/{preflight.schema.json, policy.schema.json, src/preflight.ts, package.json}, config/policy.yaml (table per 2b) |
| A2 | Answerability config [IDEA3-ANSWER] | 4 | 0 | config/adapters/{erpnext-sales-invoice.yaml, erpnext-payment-entry.yaml, gobl-invoice.yaml}, config/intents.yaml (+ config/answerability.yaml counted in A3) |
| A3 | Answerability engine (client, DuckDB) | 4 | 0 | packages/client-privacy/src/{adapters.ts (fingerprint + mapping), intents.ts (rules, optional local LLM), checks.ts (DuckDB SQL), verdict.ts}; config/answerability.yaml counted here as a 5th new file -> **5** |
| B | Client analyzer (client-privacy) | 9 | 1 | packages/client-privacy/src/{mask.ts (moved), diagnostics.ts, sensitivity.ts, jurisdiction.ts, tier.ts, context.ts, policy.ts, preflight.ts}, package.json; MOD shim paywall/scripts/client-mask.ts |
| B-t | Client analyzer tests | 4 | 0 | packages/client-privacy/test/{diagnostics, sensitivity+jurisdiction, policy, preflight}.test.ts |
| C | Analyst: JSON + T0 + subset | 0 | 4 | services/analyst/src/{db.ts, profile.ts, analyze.ts or report.ts}, test/analyst.test.ts |
| D | Paywall: forward preflight | 0 | 2 | services/paywall/src/app.ts, test/paywall.test.ts |
| E | Gateway: preflight, classes, policy, zones, mixed pool | 3 | 9 | NEW privacy/policy.ts, privacy/preflight.ts, routing/zones.ts · MOD main.ts, catalog.ts (openWeight/free/dataCollection fields), chat.ts, routing/select.ts, privacy/classify.ts (multi-label + jurisdiction), openrouter.ts (per-entry provider params), ledger.ts, server.ts (headers), scripts/local-models.ts (emit hosted entries) |
| E-t | Gateway tests | 2 | 3 | NEW test/preflight-policy.test.ts, test/zones-mixed.test.ts · MOD select.test.ts, privacy.test.ts, helpers.ts |
| F | Scripts (no-Crossmark path) | 0 | 7 | paywall/scripts/{private-ask-core.ts, private-ask.ts, e2e-private-ask.ts, e2e-core.ts}, test-console/buyer.ps1, test/{e2e, private-ask}.test.ts |
| G | Console UI | 0 | 2 | test-console/console/{server.ts, index.html} |
| H | Config, modes, prechecks, docs | 3 | 6 | NEW test-console/modes/mixed.json, config/catalog.hosted.json (or generated), prechecks/r18-hosted-nemotron/run.ts · MOD config/local-models.cpu.json, README (DESIGN), MANUAL_SETUP, STATE, BUILD_LOG, PROJECT_CONTEXT |
| | **Total** | **~35 new** | **~34 modified** | ~69 files; plus the restructure moves (xplh-4 step 4) if done together |

**Smallest slice that shows a hosted Nemotron answer within policy (phase 1):** mixed pool + one hosted entry + zone filter + `--model`/`--zone-pref` in scripts + VERDICT check: ~**12 files** (E: main.ts, catalog.ts, routing/select.ts, chat.ts, server.ts, scripts/local-models.ts, config/local-models.cpu.json + 1 test; F: private-ask-core.ts, e2e-private-ask.ts, e2e-core.ts, buyer.ps1) + manual OpenRouter key and privacy setting.

## 5. Build order (tests green before each tag)
1. Phase 1 (above) -> r18 live run lands on Nemotron (masked, residual pass, zone public-api allowed) -> tag.
2. Paywall preflight pass-through + gateway preflight intake (unsigned) + stricter merge -> tests.
3. Multi-label classes + jurisdiction + policy.yaml on the gateway; same policy on the client.
4. client-privacy package (move masker with shim) + L0 diagnostics + tier + minimum context.
5. Analyst JSON + T0 local answers; console decision card + masked preview.
6. L1 NLI (evaluate on 100-300 labelled synthetic snippets first) [CHAT xplh-3]; signing the header later.

## 6. Manual steps (owner)
- OpenRouter account: key (`sk-or-...`), privacy settings that allow the chosen free model; key entered at switch-models' hidden prompt, never written to a file.
- Choose declared jurisdiction(s) per tenant.
- Review `policy.yaml` (which class x jurisdiction may go hosted).

## 7. Risks and open questions
- Masking misses leave the machine when hosted (local keeps a miss on the PC); masked != anonymous (amounts, diagnoses, company/place names remain).
- Client hints are unverifiable; they may only tighten [CHAT xplh-3].
- Free endpoints may log prompts; open-weight must be curated; free tier limits and model churn.
- Reasoning models: token budget and latency; [CHECK] Nemotron nano/lightning live latency vs local qwen2.5-3b (~8-18 s per answer today [DOC BUILD_LOG]).
- Three maskers diverge (client, web, gateway) [CHAT xplh-4]; unify later.
- Paywall per-payer limits absent [DOC §12.2]; buyer agent prompt to Bedrock unmasked [DOC §12.1].

## Status 2026-10-24 05:35Z (BUILD_LOG H2, X1)
- Built: zones in the gateway (--auto-zones, --phi-zones, x-chainaim-zone), hosted registry entries and mode ollama-cpu-8gb-hosted, --model in the scripts (H2). Cross-file relations and read-only queries in the analyst, one shared question flow for console and terminal (X1).
- Not built yet from this plan: X-ChainAim-Preflight header and paywall forwarding, multi-label policy table, jurisdiction, answerability tiers T0/T1/T2/TA, JSON data files in the analyst.
