# ADR 0003: An analyst service (DuckDB) for cross-file analysis, outside the gateway

Date: 2026-10-17 · Status: accepted

## Context
The test console's Private chat sends attached files to the model as raw text. Real reconciliation folders hold 3 to 5
related CSV exports of 1,000 to 1,000,000 rows (production and collections from practice-management software, bank
statements, ERP, income, tax). The local models take about 16,000 characters per question (deepseek-r1-8b) or 48,000
(the gateway cap), so even one 1,000-row file does not fit, and small models add up long columns unreliably.

## Decision
- **D1.** Cross-file analysis runs in code, before the model: a new service, `services/analyst`, reads every row with
  DuckDB in memory, judges each pair of files along the money flow per period (tie or ratio), finds the onset of a
  variance, matches rows (by reference, or by amount and date, one-to-one and many-to-one), and ranks findings by money
  impact. The model receives only a budgeted evidence pack and explains it.
- **D2.** The analyst is compute only: no model calls, no keys, no outbound network, `127.0.0.1` only. The console tab
  sends the evidence to the model through the existing gateway route (masking, ledger and limits unchanged) and posts
  the answer back to the analyst for a number check.
- **D3.** DuckDB is a dependency of the analyst only. The gateway keeps its rule of Node built-ins and no runtime
  dependencies; nothing in `services/gateway` changes.
- **D4.** The analyst reads only inside `allowedRoots` of `config/data-sources.json` (lexical and real-path checks, links
  that lead out refused) and only CSV/TSV. After loading, DuckDB file access is switched off and the configuration
  locked. It writes only recipes (column names, settings) and manifests (sizes, hashes, counts, timings) under its work
  folder; findings with real values only with `--keep-findings`.
- **D5.** A person confirms each folder's recipe (column roles, file kinds, flow) once; the proposal is made by rules.

## Why
- Exact numbers and complete coverage: code reads 100% of rows; the model never adds columns.
- Scale: measured 2.4 million rows in 39 s on a 2-core VM; the evidence pack stays near 8,000 characters.
- Privacy: full files never leave the PC; only small evidence packs reach a model, and they still pass the gateway's
  masking.
- Consistent with ADR 0002: the analyst does no inference and is not part of the production deployment.

## Consequences
- A second process for the console's analysis tab (`test-console/start-analyst.cmd`); the other tabs work without it.
- A native dependency (DuckDB prebuilt binaries for Windows, Linux and macOS), pinned with a lockfile; `npm audit` on
  updates.
- The analyst sees raw files, so it must run where the data lives (this PC or a customer's network), never as a public
  service. A hosted or paid version needs its own design.
- Recipes are needed per folder; a wrong role or flow gives wrong judgements, which is why the person confirms them.
