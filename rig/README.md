# Test rig (L0)

Several tenants, each with its own XRP Ledger TestNet wallet, pay the paywall in
RLUSD again and again, so the paywall's payment log fills the way it would with
many agents. Code: `services/paywall/scripts/rig.ts` (command line) and
`services/paywall/scripts/rig-core.ts` (logic).

- `tenants/<id>/tenant.json`: the tenant's id (the folder name), a display name,
  and `seedPrefix`, the variable prefix its seed is read from
  (`<seedPrefix>_TESTNET`). The seed itself is never stored here.
- `tenants/<id>/queries.json`: the texts the tenant sends. They are synthetic:
  every name, e-mail and number is invented. Each is masked on this machine
  before it is sent; a text that still holds something to mask stops the run
  before anything is paid.
- `out/`: one JSON Lines file per run, one record per call (tenant, payer
  address, result, HTTP status, amount, transaction, latency, masked-entity
  counts) and a summary line. No seed, request text or answer is written.
  Not committed (`.gitignore`).

Run from `services/paywall`:

    node scripts/rig.ts --url http://127.0.0.1:8080 --dry-run
    node scripts/rig.ts --url http://127.0.0.1:8080 --calls 10

Set-up steps (wallets, XRP, trust lines, RLUSD) are in `MANUAL_SETUP.md`,
"Test rig (L0)".
