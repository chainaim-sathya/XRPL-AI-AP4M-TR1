# chainaim-analyst

Exact cross-file analysis of a folder of CSV/TSV files, for the test console's **03 Private chat + analysis** tab.
It reads every row of every file with [DuckDB](https://duckdb.org) (in memory), finds what does and does not add up,
and returns a small **evidence pack** that the console sends to the model through the gateway. The model reasons over
exact, masked results instead of raw rows.

**Compute only.** The analyst never calls a model, holds no keys, listens on `127.0.0.1` only, and reads only inside the
`allowedRoots` of `config/data-sources.json`. After loading a folder's files it switches DuckDB's file access off and
locks that setting, so nothing afterwards can read or write any file. See `docs/adr/0003-analyst-service-duckdb.md`.

## Run

```powershell
test-console\start-analyst.cmd          # installs DuckDB once, then serves http://127.0.0.1:8740
```

or by hand, from this folder: `npm ci` (or `npm install` the first time, which creates `package-lock.json`; commit
it), then `node src/main.ts [flags]`. Node ≥ 22.22. DuckDB ships prebuilt binaries for Windows, Linux and macOS.

## How a folder is analyzed

1. **Profile** (`POST /profile {folder}`): every CSV/TSV in the folder (not sub-folders), its columns and their types
   (date, number or text, from a sample), row counts and date ranges, plus a **proposed recipe**.
2. **Recipe** (`POST /recipe {folder, recipe}`), confirmed once by a person and saved in
   `<work-dir>/recipes/<folder-id>.json` (column names and settings only, no data):
   - per file: `kind` (production, billing, income, collections, deposits, ledger, tax, adjustments, other),
     `roles` (`date`, `amount` or `debit`+`credit`, `party`, `reference`, `category`), `measure` (`net`, `inflows`,
     `outflows`, `abs`), optional `dateFormat` (strptime syntax), `include`;
   - `flow`: the order money moves through the files, e.g. production → collections → deposits;
   - optional `settings` overriding the thresholds below for this folder.
3. **Analyze** (`POST /analyze {folder}`): for each file, totals per period, possible duplicates, unusually large
   amounts and empty periods; for each adjacent pair in the flow (plus first → last), a judgement per period, the
   onset of the latest run of "off" periods, and row matching. Findings are ranked by money impact. A manifest
   (file sizes, hashes, row counts, timings; no data) is written to `<work-dir>/runs/<folder-id>/`.
4. **Evidence** (`POST /evidence {runId, budget?}`): the text for the model, within `min(budget, --evidence-max-chars)`.
   It narrows instead of truncating (older periods, then example rows, then the smallest findings) and refuses when
   even the file list does not fit.
5. **Verify** (`POST /verify {runId, answer, evidence}`): numbers in the model's answer that are not in the evidence
   (a figure the model derived itself is listed as "not found", not as wrong).
6. **Status** (`POST /status {folder}`): have the files changed (size or modified time) since the last analysis?

### Judging a pair, per period

- **tie** — the later stage should equal the earlier one (collections vs deposits). gap = B − A.
- **ratio** — the later stage should keep a stable share of the earlier one (payments are a fraction of charges).
  The first period is warm-up; expected = A × the median B/A of the other periods; the band widens to 3 × the median
  absolute deviation of those ratios when they are noisy. A falling collection rate shows; a normal shortfall does not.
  If a problem spans more than half the periods, pin the ratio with `settings.expectedRatio` in the recipe.
- **off** = beyond the band AND over `--variance-amount`; **watch** = beyond half the band AND over that amount.

### Row matching

- **By reference** when both files have a `reference` role (claim, invoice, check number). Unmatched rows of the
  earlier file older than `--aging-days` at the later file's last date are the ones that count (e.g. claims never paid).
- **By amount and date** otherwise: one-to-one, then many-to-one (all unmatched rows of a day summing to one row, a
  daily batch deposit).
- Unmatched amounts are broken down by party and compared with each party's normal share (e.g. "42% of unpaid claims
  vs 19% of all charges: 2.2× its normal share") when parties repeat.
- Under 20% (reference) or 50% (amount) matched on both sides, the pair is not row-for-row comparable; matching is then
  reported as not informative and produces no findings.

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--port` | 8740 | listens on 127.0.0.1 only |
| `--data-config` | `../../config/data-sources.json` | allowed data folders (shared with the console) |
| `--work-dir` | `<first allowedRoot>/_analyst` | recipes and manifests; refused as an analysis folder |
| `--period` | month | week, month or quarter |
| `--baseline-periods` | 3 | periods before a run shown as its baseline (tie pairs) |
| `--variance-pct` | 2 | band, % of the earlier stage (minimum for ratio pairs) |
| `--variance-amount` | 100 | gaps at or under this never count |
| `--pair-mode` | auto | auto (tie when the median \|ratio − 1\| ≤ 10%), tie, ratio |
| `--match` | auto | auto, one-to-one, many-to-one, none |
| `--date-window-days` | 3 | amount matching |
| `--amount-tolerance` | 0.01 | amount matching |
| `--aging-days` | 30 | unmatched rows older than this count |
| `--evidence-max-chars` | 16000 | ceiling for an evidence pack |
| `--evidence-rows-per-finding` | 3 | example rows per finding |
| `--max-findings` | 12 | |
| `--max-bytes` | 500000000 | largest file analyzed |
| `--max-files` | 20 | most data files in one folder |
| `--keep-findings` | off | also write findings.json (holds real amounts and names) next to each manifest |
| `--runs-in-memory` | 10 | analyses kept for evidence and verify calls |

## Tests and test data

```powershell
npm test                                                  # 16 tests on generated data with planted problems
node scripts/make-fixtures.ts --out C:\PRIV-AI-DATA\demo\clinic-a   # synthetic production, collections, bank CSVs
```

The generator plants a card-deposit leak from 2026-06, a payer that stops paying from 2026-07 and duplicated payment
rows (flags: `--production-rows --months --start --leak-start --leak-rate --payer-drop-start --duplicates --seed`).

**Measured** (cloud VM, 2 cores, 7 GB): 19,705 rows in 0.6 s; 243,353 rows (14 MB) in 6 s; 2,433,334 rows (132 MB)
in 39 s at 1.3 GB peak memory. Evidence packs stay at about 8,000 characters whatever the row count.

## Limits (known)

- CSV/TSV only (PDF text is handled by the console's raw "Chat with files" path).
- Day-first dates are tried after US dates; set `dateFormat` in the recipe for day-first files.
- Thousands separators must be commas (`1,240.50`); European `1.240,50` is not parsed yet.
- One folder level; sub-folders are not read.
- The proposal is made by rules on column names and types; an LLM-assisted proposal (via the gateway) is not built.

## Questions across files (no recipe needed)

- **Relations** (`POST /relations {folder}`): every file becomes a typed table named after the file (number columns
  DOUBLE, date columns DATE). Columns of DIFFERENT files are related when their distinct values (upper, trimmed)
  overlap: `overlap` = shared values / distinct values of the smaller side (>= `--relation-min-overlap`, and at least
  `--relation-min-shared` values). `key` when one side is unique per row or both have many values, else `category`.
  The header names only break ties (Claim # = Claim No, Patient ID = pt_id); money and date columns are never related.
  The answer includes `schema`: the text a model gets, with headers, types and relations and no data values.
- **Query** (`POST /sql {folder, sql}`): one SELECT (or WITH ... SELECT), checked (no comments, one statement, no
  file/setting/extension functions), run after file access is locked, at most `--sql-max-rows` rows, stopped after
  `--sql-timeout-ms`. 400 with the reason when refused.
- **The whole question** (`src/crossask.ts`, used by the console's POST /crossask and by `scripts/ask.ts`):
  relations -> the model writes the query from the headers -> this service runs it -> optionally the model words the
  answer from the result rows (through the gateway, which masks and applies its zone rules) -> numbers checked.

```powershell
node scripts\ask.ts --folder C:\PRIV-AI-DATA\pm\clinic-a --relations
node scripts\ask.ts --folder C:\PRIV-AI-DATA\pm\clinic-a --question "Paid amount per payer for billed claims?" [--model local/qwen2.5-3b] [--phrase none] [--sql "SELECT ..."]
```

