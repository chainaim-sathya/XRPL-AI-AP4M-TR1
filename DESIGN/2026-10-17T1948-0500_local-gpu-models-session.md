# Local GPU models for the test console: session summary and decisions

- **Date:** 2026-10-17, 19:48 (UTC-05:00)
- **Repository:** `C:\SATHYA\CHAINAIM3003\mcp-servers\FINAGENTS\PRIVAI1\chainaim-router`
- **Goal:** run the test-console UI (`http://127.0.0.1:8730`) against local Ollama models on this PC's RTX 3070 Ti, with models, budgets and the default chosen in config rather than in code. The longer-term goal is reconciling CSV exports (ERP, practice management, bank, income sheet, tax return).
- **Status:** working end to end on the GPU. Private chat answers from local models; the default model is `local/deepseek-r1-8b`. The UI change separating question and data (section 6) is built but **not yet tested in a browser**.

---

## 1. Architecture as it runs now

| Part | Runs where | Role |
|---|---|---|
| Ollama + models (`deepseek-r1:1.5b`, `qwen2.5:3b`, `deepseek-r1:8b`) | Windows host, **GPU** (RTX 3070 Ti, 8 GB) | Local inference |
| `ca-gateway` | Docker | Scan, mask, route, call the model, restore. Reaches Ollama at `http://host.docker.internal:11434/v1` |
| `ca-presidio` | Docker | Entity detection (scan and mask need only this) |
| `ca-paywall` | Docker | x402 on Algorand TestNet (`AVM_PAY_TO` = a TestNet address made with `services/paywall/scripts/new-account.ts`). The console bypasses it for chat; it calls the paywall only to show the 402. |
| `ca-openrouter-stub` | Docker | Echo stand-in (stub mode) |
| Test console UI | Windows host, `node test-console/console/server.ts` via `start.cmd` | Port 8730; calls the gateway at 8720 with the local key |

Privacy holds in local mode: the chat goes UI → gateway (masks) → Ollama on this PC → gateway (restores). No OpenRouter key is set, so Jev and hosted models are off (`main.ts`).

## 2. Final decisions

| # | Decision | Why |
|---|---|---|
| D1 | **One registry file, `config/local-models.json`, is the only place local models are configured**: `defaults` plus per-model overrides (`numCtx`, `maxOutputTokens`, `supportsTools`, `quality`, `tasks`, `speed`), `defaultModel`, `ollamaUrl` | No hardcoded model names or URLs in code or scripts; adding a model is one entry |
| D2 | **Everything else is generated** by `scripts/local-models.ts` into `config/generated/` (gitignored): `catalog.local.json`, `scores.local.json`, `summary.json`, `ollama/*.Modelfile` | Removes duplicated and contradictory settings |
| D3 | **Per-model context comes from Ollama variants** (`chainaim-<model>-ctx<N>`, created with `ollama create` from `FROM <model>` + `PARAMETER num_ctx N`), not one global `OLLAMA_CONTEXT_LENGTH` | Each model gets its own context; the variants reuse the same layers, so no extra disk |
| D4 | The generator **checks each model's trained maximum context** through Ollama `/api/show` and caps `numCtx`; a model that isn't pulled stops the switch with `ollama pull <model>` | Fails fast instead of failing at request time |
| D5 | **`--max-output-tokens` = the smallest model `maxOutputTokens`**, set automatically. **Keep `maxOutputTokens` equal (8192) for all models.** | Otherwise `failedFilter` in `routing/select.ts` excludes models whose output limit is below the request's budget |
| D6 | **The default model always ranks first**: the generator gives it the highest quality, every task, **and speed `fast`** | The scoring formula (`routing/scores.ts`) adds a speed bonus on easy questions; without forcing `fast`, a slow default lost 10 of 35 task × difficulty cases (bug found and fixed this session) |
| D7 | **Default model: `local/deepseek-r1-8b`.** qwen2.5-3b for large files and listing/extraction; **1.5b for quick tests only** | 1.5b answered "capital of India" correctly once and wrongly three times (Mumbai, Panipet/Kottayam); 8b answered New Delhi |
| D8 | Mode files (`test-console/modes/*.json`): `stub`, `hosted` (OpenRouter), `ollama` (GPU: 240 s per attempt, 2 attempts), `ollama-cpu` (280 s, 1 attempt, which is under the console's ~300 s wait) | Switching is one command; no script edits |
| D9 | **Model choice per request** uses the gateway's existing `model` field (a pinned model is tried alone, with no fallback). The **UI pick list** sends it on every Send, remembers the pick in `localStorage`, and defaults to `defaultModel` from the registry. | Pick once, sticky; no gateway code change |
| D10 | **Inference runs on the GPU:** ASUS GPU Mode **Ultimate** (or Standard), charger connected, Ollama restarted after a mode change | Eco mode switches the RTX card off, so Ollama silently uses the CPU |
| D11 | **Private chat separates the question from the attached data.** The data is kept in page memory only (never in browser storage). Earlier answers are listed with "Use in next question" checkboxes; ticked ones go as `assistant` turns. Only the answer text is reused, not R1's `reasoning` field. | Follow-ups without re-attaching; the question can't be buried in the CSV; prompt size stays controlled |
| D12 | **Reconciliation design (not built):** a deterministic engine (DuckDB in Node) matches rows; the LLM only maps columns (qwen), explains exceptions and does tax tie-out narrative (8b). The model never reads full files. | Exact numbers; files of 3 × 1,000–10,000 rows don't fit any prompt; small models add numbers badly |
| D13 | No gateway (`services/gateway/src`) or Dockerfile changes; production (Railway, `openrouter-free`) is unaffected | Keep the privacy pipeline and its tests untouched |

## 3. Files changed or added this session

| File | Change |
|---|---|
| `config/local-models.json` | **New.** The registry (D1). The 8b has `numCtx` 12288 so it fits on the GPU; the others use 32768. `defaultModel` is `local/deepseek-r1-8b`. |
| `scripts/local-models.ts` | **New.** Generator (D2–D6). Flags: `--in`, `--out-dir`, `--ollama-api`, `--create-variants on\|off`, `--check-context on\|off`, `--ollama-bin` |
| `test-console/switch-models.ps1` | Rewritten to work from mode files (`-To <mode>`, `-List`, `-Catalog`, `-ModesDir`, `-Image`, `-Container`, `-Network`, `-HostPort`, `-PresidioUrl`, `-Question`, `-TestTimeoutSec`, `-SkipTest`, `-OllamaVariants on\|off`). It runs the generator when a mode has `localModels`. **Bug fixed:** a PowerShell comma-vs-`+` precedence split `--scores` into two arguments. |
| `test-console/modes/stub.json`, `hosted.json`, `ollama.json`, `ollama-cpu.json` | **New** mode files (D8) |
| `test-console/use-ollama.cmd` | **New** one-click launcher; `use-stand-in.cmd` and `use-real-models.cmd` now call `-To stub` / `-To hosted` |
| `test-console/console/server.ts` | Flags `--default-model`, `--models-file`, `--generated-summary`, `--port`, `--gateway`, `--paywall`, `--spy`. New route `/gateway/models` (ids, per-model context, max output, default). |
| `test-console/console/index.html` | The model pick list (D9); separated question and data, answer checkboxes, size line, New conversation (D11) |
| `.gitignore` | Excludes `config/generated/` |
| `config/catalog.ollama.json`, `config/scores.ollama.json` | **No longer used** (superseded by the generated files); safe to delete |

## 4. Facts established (measured on this PC)

- Node must be **≥ 22.22** (the repo's `engines`); installed **24.22.0**. Node 20 can't run the repo's `.ts` scripts.
- **`npm --prefix services/paywall install` corrupts `services/paywall/package.json`** by adding `"chainaim-router": "file:../.."`, which breaks the paywall Docker build. Fix: `git checkout -- services/paywall/package.json services/paywall/package-lock.json`, then run `npm install` inside `services/paywall`. **The setup .docx step 1 should be corrected to this.**
- Docker reaches Ollama on the host at `host.docker.internal:11434` (verified from a container).
- GPU: RTX 3070 Ti Laptop, driver 595.97, CUDA 13.2, 8 GB. It was hidden by ASUS **Eco** mode; it works in Ultimate.
- 1.5b speed: CPU 36 tokens/s; GPU answered a short question in 1.9 s.
- 8b on CPU: 44.6 s for a short question; a CSV prompt timed out at 300 s.
- **Ollama returns R1 thinking in a separate `reasoning` field.** Thinking and answer share one output budget. With a 2048 cap the CSV answer came back empty, and `dispatch.ts` `parseCompletion` rejects an empty answer as `upstream_error` (status 200), then a 503 plus a 30 s cooldown. Fixed with the 8192 budget.
- Limits: gateway chat 48,000 characters (`MAX_CHAT_CHARS`); prompt tokens are estimated as characters ÷ 4; a request is eligible only if prompt + max output ≤ context (`failedFilter`). Room now: about 48,000 characters for 1.5b/qwen (gateway cap), about 16,000 for the 8b.
- Presidio found **nothing** in the sample bank CSV (`dataClass: none`, `found: []`). Masking coverage for real statements still needs checking before any hosted use.
- The browser's console warnings (`contentscript.js`, `ObjectMultiplex`) come from a wallet extension; they're unrelated.
- In PowerShell, `curl.exe -d "{\"...\"}"` breaks the JSON; use `Invoke-RestMethod` with a single-quoted body.

## 5. Everyday commands (run from the repository folder)

```powershell
test-console\use-ollama.cmd            # regenerate from config\local-models.json and restart the gateway (GPU)
test-console\start.cmd                 # UI at http://127.0.0.1:8730 (keep the window open)
powershell -NoProfile -ExecutionPolicy Bypass -File test-console\switch-models.ps1 -To ollama-cpu   # CPU timings
powershell -NoProfile -ExecutionPolicy Bypass -File test-console\switch-models.ps1 -List
ollama ps                              # PROCESSOR must say 100% GPU
docker logs --tail 20 ca-gateway
docker exec ca-gateway sh -c "tail -n 3 /data/ledger/*.jsonl"
```
**To change models:** edit `config\local-models.json`, then run `use-ollama.cmd`. Restart `start.cmd` only when `server.ts` changes.
**To restart Ollama after a GPU mode change:** `taskkill /F /IM "ollama app.exe"; taskkill /F /IM ollama.exe`, then start Ollama from the Start menu.

## 6. Open items, in priority order

1. **Test D11 in the browser.** Attach a statement once, ask, then follow up; untick an answer; New conversation.
2. **Confirm the 8b fits the GPU at 12288 context:** `ollama ps` should show `100% GPU`. If it shows a CPU/GPU split, set the 8b's `numCtx` to 8192 and run `use-ollama.cmd`.
3. **Optional Ollama settings** (verify against Ollama's docs first): `OLLAMA_KEEP_ALIVE=-1`, `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`.
4. **Proposed, not built:** a per-model `temperature` in the registry, written into the Modelfile (about 0.2 for qwen; about 0.6 for R1, to be verified on the model page).
5. **Proposed, not built:** a quality and benchmark script (`scripts/local-eval.ts`: `--models`, `--cases`, `--runs`) with known-answer cases. Reuse `eval/` and `scripts/iter0-matrix.ts` if they fit.
6. **Check Presidio masking on real statements** (01 Scan and mask; the ledger `found` column).
7. **Reconciliation service (D12).** Decisions still needed: tax-return format (CSV or PDF) and which source pairs to reconcile. Planned flags: `--data-dir`, `--sources`, `--rules`, `--mapper-model`, `--reasoner-model`, `--max-exceptions-explained`.
8. **Fix the setup .docx** (npm `--prefix` step; Node ≥ 22.22; add `use-ollama.cmd`).
9. Optional: delete the unused `config/catalog.ollama.json` and `config/scores.ollama.json`.

---

## 7. Update 2026-10-17, 21:08 (UTC-05:00)

| # | Decision | Why |
|---|---|---|
| D14 | **Ollama runs with `OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q8_0`** (Windows user environment variables; Ollama restarted from the Start menu). Global: applies to every model. | The 8b at `numCtx` 12288 loaded `13%/87% CPU/GPU` (7.2 GB) and timed out at 240 s on a chart request. After the change: **6.0 GB, `100% GPU`**, same 12288 context. Source: Ollama FAQ (q8_0 ≈ half the K/V memory of f16, needs Flash Attention; high-GQA models such as Qwen2 may lose more precision). |
| D15 | **"Open page" links for HTML in answers.** `server.ts`: `POST /view` (JSON only) stores a page in memory; `GET /view/<id>` serves it with a sandbox CSP (`sandbox allow-scripts`, `connect-src 'none'`, scripts/styles only from `--view-script-src`). Flags `--view-max` (20), `--view-ttl-min` (60), `--view-max-bytes` (1000000), `--view-script-src`. `index.html` shows "Open page in a new tab" under answers containing a ```html block or a raw `<!DOCTYPE html>…</html>`. | Model output is untrusted and the console holds the gateway key, so the page runs in an opaque origin with no network access. Tested in a VM (200 + CSP, 415 for text/plain, 404 for unknown id, flag validation, extractor). **Not yet tested in Chrome.** |
| D16 | `test-console/watch.ps1` opens one window per backend view (`-Views ledger,gateway,ollama,gpu,ollamalog`, `-IntervalSec`, `-Tail`, `-RawLedger`, `-Container`, `-LedgerGlob`, `-OllamaLog`). | Watch requests live. **Not yet run** (no PowerShell in the VM). |

**Facts measured**
- `deepseek-r1:8b` is architecture **qwen3**: 36 layers, 32 query heads, 8 KV heads, key/value length 128 (GQA 4:1), trained context 131072, Q4_K_M. f16 KV cache = 144 KiB per token = 1.69 GiB at 12288 tokens; q8_0 ≈ 0.90 GiB.
- Ledger: the failed chart request was `timeout` at 240003 ms with a 1,129-character prompt; an earlier 6,697-character request succeeded in 176,725 ms (both while split CPU/GPU).
- D11 verified in the browser: the size line counts data and ticked answers and uses 16,384 characters for the 8b.
- The 8b's model-written chart HTML was broken (`getContext(2)`, invented rows).

**Open (added)**
- The ledger shows **one** attempt on timeout although the `ollama` mode is meant to allow 2 (D8). Check whether a pinned model is retried.
- Re-time the chart request on 100% GPU; check qwen2.5-3b and the 1.5b with q8_0 (`ollama ps`, answer quality).
- Proposed: a deterministic chart built in code from the attached CSV (D12 approach) instead of model-written chart HTML.
- Fallback if a model splits again: `maxOutputTokens` 6144 for all models with the 8b `numCtx` 10240 keeps ≈16,384 prompt characters.

---

## 8. Decision 2026-10-17, 21:37 (UTC-05:00): reading local data files (design approved, NOT built)

| # | Decision | Why |
|---|---|---|
| D17 | **Data lives in `C:\PRIV-AI-DATA\chainaim3003\fin\statements`**: outside every git repository and outside the Claude Desktop filesystem connector's allowed root (`C:\SATHYA\CHAINAIM3003\mcp-servers`, verified). Keep it out of that connector; do not widen the connector to `C:\SATHYA\CHAINAIM3003`, which would include it. Only synthetic samples stay in the repo (`test-console/samples`). | Separation of code and data; least privilege; statements must never reach a hosted model unmasked (a Claude chat with the connector could read them); avoids accidental commits, Docker build contexts, indexers. |
| D18 | **User-driven loading through a read-only registry, not model-driven MCP tool calls.** `config/data-sources.json` (gitignored; commit `config/data-sources.example.json`) lists named sources: `id`, `root`, `extensions`, `maxBytes` (per extension), `recursive`. The console server takes `--data-sources <path>`; the reconciliation engine reuses the same file via its planned `--sources`. | Claude Desktop/MCP-UI pattern (mcp-config.json, server-filesystem, tool loop; per past chats, repo not reachable: GitHub 404) lets the model read raw files as tool results, bypassing masking; the R1 models have `supportsTools: false`; prompt-injection risk; extra dependencies. Keep the idea (declared allowlist), not the protocol. MCP fits later as ChainAim exposing its own services to agents. |
| D19 | **Server rules:** `GET /data` (sources and file names, sizes, dates; never content), `GET /data/<source>/<file>`; realpath containment inside `root` (blocks `..` and escaping symlinks); extension allowlist; per-extension size cap; `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding); bind 127.0.0.1; responses `nosniff`, `no-store`. | Statements are confidential. |
| D20 | **PDFs supported.** Server returns PDF bytes (`application/pdf`); the page runs its existing in-browser pipeline (`pdfText`: pdf.js text, tesseract OCR for scanned pages, `PDF_SETTINGS.ocrMaxPages` 10). Text files go in as text. Loaded files behave exactly like attached ones (D11: page memory only, masked by the gateway). | Reuses tested code; extraction stays on this PC. pdf.js/tesseract load from CDNs the first time (library downloads only, no data). Server-side PDF extraction for the reconciliation engine is a separate decision (open item 7, tax-return format). |

**Still to confirm:** whether `C:\SATHYA` is inside OneDrive or another sync tool (if so, move the data folder outside it). The folder must be created manually (outside the folder granted to Claude).

| D21 | **The folder holds many files; the UI loads several at once.** File list with checkboxes, Select all / none, filter by name, each file's size; a running total of the selection against the picked model's room (same rule as the size line: min(48,000, (numCtx − maxOutputTokens) × 4) characters); Load adds each file as its own pill under Attached data (removable). Over the room: Load is refused with a message naming how much to remove. Questions across more files than fit go to the deterministic engine (D12), not the prompt. | 3 × 1,000–10,000-row files cannot fit any local model's prompt (8b ≈ 16,384 characters); code computes, the model explains. |

**Amendment 21:52:** the data folder is **`C:\PRIV-AI-DATA\chainaim3003\fin\statements`** (replaces `PRIV-AI-1-DATA` under `C:\SATHYA`, because `C:\SATHYA` is synced by OneDrive). Outside `C:\SATHYA`, so outside OneDrive (assumed; confirm it is not added to OneDrive), outside every repository and outside the Claude connector's allowed root. Layout leaves room for more sources (`fin\erp`, `fin\tax`, ...). No "Open folder…" button for now (named sources cover it). Folder not created yet (manual).

| D22 | **"All files" vs "some files" is chosen at three levels.** (1) Config, what the server allows: per source `include` / `exclude` glob patterns (default `include: ["*"]` within `extensions`), `recursive`. (2) UI, what goes with a question: mode **"Pick files"** (checkboxes, Select all, filter) or **"Whole source"** (every allowed file in the source, re-read at each Send so newly added files are included; refused with a clear message when the total exceeds the model's room). (3) Engine: `--sources statements` uses every file the source allows; optional `--files <glob>` narrows it. | One definition of what is usable (config), per-question choice in the UI, the same rules for the reconciliation engine. |

| D23 (22:02, supersedes "one fixed folder per source" and "no Open folder button") | **The UI opens and changes folders, inside server-side allowed roots.** Config gains `allowedRoots` (default `["C:\\PRIV-AI-DATA"]`) and `defaultFolder` (`C:\\PRIV-AI-DATA\\chainaim3003\\fin\\statements`). The "From data folder" area shows the current folder (starts at `defaultFolder`, last choice remembered in localStorage as a path string only), a **Change folder…** button that opens a server-driven folder browser (up/down through sub-folders, never above an allowed root), then the D21/D22 file list (Pick files / Whole source). Server: `GET /data/folders?path=` lists sub-folders, `GET /data/files?path=` lists files, `GET /data/file?path=` returns one file; every `path` is realpath-resolved and must lie inside an allowed root (else 403); extension allowlist, size caps, include/exclude, Host check, read-only, no auto-create (missing default folder reported). Named `sources` stay for the reconciliation engine. Optional later: a Chrome "Open any folder…" (File System Access API) for folders outside the allowed roots. | The user wants to pick different folders from the UI with a default. A path typed in the browser and honoured anywhere on disk would let anything that drives the page read any file the user can (SSH keys, .env, browser profiles); confining choices to configured roots keeps the server as the trust boundary while giving folder freedom under `C:\PRIV-AI-DATA`. |

**Built 22:15 (D18-D23, folder-based form):** `server.ts` `--data-config` (default `config/data-sources.json`, re-read per call); `GET /data/config`, `/data/folders?path=`, `/data/files?path=`, `/data/file?path=` (lexical then realpath containment in allowedRoots, symlinked folders/files not listed and refused, extension allowlist, exclude globs, per-extension maxBytes, maxFiles, Host check, nosniff/no-store, read-only); startup line reports the data folders and a missing default. `config/data-sources.example.json` committed; `config/data-sources.json` created from it and gitignored. `index.html`: "From data folder" (current folder, Change folder… browser inside allowedRoots, Refresh, Pick files with filter/Select all/None/Load selected and a running total, Whole folder re-read at each Send); loaded files are attached data with origin `folder`/`whole`; Send refuses a prompt larger than the model's room. VM tests passed (listing, read, PDF type, 403 outside root, `..`, file and folder symlink escapes, excluded and disallowed types, 413 over size, 400 relative, 404 missing, bad Host 403); page script `node --check` OK. **Not yet tested on Windows or in the browser** (Windows paths and case-insensitive comparison untested).

---

## 9. Analyst service built (2026-10-18, ~00:10 UTC-05:00) — tab 03 UI NOT built yet

| # | Decision / state |
|---|---|
| D24 | **`services/analyst`** (ADR 0003): compute-only DuckDB service on 127.0.0.1:8740, `@duckdb/node-api` 1.5.6-r.1 (MIT, prebuilt win32-x64). Routes `/healthz`, `/profile`, `/recipe`, `/analyze`, `/status`, `/evidence`, `/verify`. Files loaded as text, then `enable_external_access=false` + `lock_configuration=true` before any analysis. Recipes and data-free manifests under `<first allowedRoot>/_analyst` (hidden by `hideFolders: ["_*"]`). |
| D25 | **Judging pairs:** tie (B should equal A) vs ratio (B a stable share of A: first period warm-up, expected = median ratio of the other periods, band = max(variancePct, 3×MAD)); auto picks ratio when median \|B/A−1\| > 10%. off = band AND amount; watch = half band AND amount. Onset = latest run of off periods with baseline. |
| D26 | **Matching:** by reference when both files have one (unmatched earlier-file rows count only when older than `--aging-days`); else amount + date window, one-to-one (binary search per amount) then many-to-one (daily running totals). Not informative under 20% (reference) / 50% (amount). Unmatched broken down by party vs normal share when parties repeat. |
| D27 | **Evidence pack** budgeted (≤ `--evidence-max-chars` 16000), narrowing order: older periods (to 6, then 3), example rows, smallest findings; refuses when even the file list does not fit. `/verify` lists answer numbers not found in the evidence. |
| D28 | **Console:** `server.ts` `--analyst` (default http://127.0.0.1:8740) and `/analyst/*` proxy (known routes only, JSON only, Host check, 503 with a start-analyst.cmd hint when down); `hideFolders` in data-sources; `test-console/start-analyst.cmd` (npm install first time → commit package-lock.json; npm ci after). |

**Verified (cloud VM):** 16/16 tests (`npm test`): profile/proposal, planted card-deposit leak onset 2026-06, ratio mode + claim matching, payer drop 2.2× normal share, duplicates, evidence budgets, number check, parsing, confinement incl. junction/symlink escape. Scale: 19,705 rows 0.6 s; 243,353 rows 6 s; 2,433,334 rows 39 s, 1.3 GB peak. Proxy tested in the repo VM with a stand-in analyst (pass-through, 404, 415, 403 Host, 503 down).
**Not verified:** on Windows (DuckDB binary install, C:\ paths, case-insensitive containment, junction test) and the tab 03 UI (not built).
**Next:** tab 03 "Private chat + analysis" in `test-console/console/analysis.js` + shared `chat-core.js` extracted unchanged from tab 02 (regression checklist + smoke.ps1). Work stays on `main` (no branch, decided 2026-10-17 23:56): `v1.1.0` is the rollback point; commit and tag (next: `v1.2.0`) once tested.

**Windows verification (2026-10-18 02:30):** `npm install` (DuckDB 1.5.6-r.1, 4 packages, 0 vulnerabilities; `package-lock.json` created) and `npm test` 16/16 pass on Windows (C:\ paths, case-insensitive containment, junction escape refused).
**Fixed on this PC:** npm crashed with "Class extends value undefined" because `C:\Program Files\nodejs` is an nvm-windows link that pointed at `nvm\v20.19.1`, and a Node 24 installer had written into it (npm 11 mixed with npm 10 files). Fixed with `nvm install 24.22.0` + `nvm use 24.22.0` (admin); the link now targets `nvm\v24.22.0`. Do not uninstall "Node.js" from Windows Apps (it would delete through the link); `nvm\v20.19.1` is damaged — reinstall with nvm if Node 20 is ever needed.
