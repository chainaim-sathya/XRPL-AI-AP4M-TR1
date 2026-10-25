# DESIGN/README: new team member - buyer wallet (XRP + RLUSD) and the end-to-end paid private chat

Written 2026-10-23 22:09 (UTC-05:00) = 2026-10-24 03:09 UTC, from the runs that passed on 2026-10-24
(BUILD_LOG.md: P1, P2, E2E-2; last pass tx 8C780E36...79F7). TestNet only. Windows PowerShell.

What you will have at the end: your own TestNet buyer wallet, holding XRP and RLUSD, whose seed lives
only in a file outside the repository; and one command that shows BEFORE balances, a masked private
chat paid in RLUSD over x402 (no browser wallet), AFTER balances, the payment as the ledger records it,
and a 10-check VERDICT.

Breadcrumb: tools in `services/paywall/scripts/` (new-account.ts, trust-line.ts, buy-rlusd.ts,
balances.ts, e2e-private-ask.ts); containers in `test-console/stack.ps1` and `test-console/switch-models.ps1`;
evidence in BUILD_LOG.md; how the ask and the payment are tied in DESIGN/xrplh-6-ASK-PAYMENT-ATOMICITY-2026-10-23T2102.md.

## Fastest: run the script (copy, change the two values, paste)

`test-console\buyer.ps1` runs every wallet step and the end-to-end chat. **-Prefix** (your wallet name) and
**-EnvFile** (your seed file, outside every repository) are required parameters with no default.
It writes a new seed straight into -EnvFile (UTF-8, no BOM) and never prints it.

```powershell
cd C:\SATHYA\CHAINAIM3003\mcp-servers\FINAGENTS\PRIVAI2\chainaim-router-private-ai-2      # CHANGE: where you cloned
$P = "XRPL_SEED_B02"                                         # CHANGE: your own prefix (B01 is taken)
$F = "C:\PRIV-AI-SECRETS\mywallets.env"                     # CHANGE: your seed file, outside the repository

.\test-console\buyer.ps1 -Step setup     -Prefix $P -EnvFile $F     # create + fund + trust line + buy 1 RLUSD (asks before buying) + balances
.\test-console\buyer.ps1 -Step e2e       -Prefix $P -EnvFile $F     # BEFORE, masked paid ask, AFTER, ledger check, VERDICT
```

Single steps: `-Step create | address | fund | trustline | buy | balances | e2e`. Options: `-Amount 1`, `-MaxXrp 13`,
`-File <.txt>`, `-Question "..."`, `-Paywall http://127.0.0.1:8080`, `-SettleWaitSec 30`, `-Yes` (no buy prompt).
The stack (section 1 / blocks C-D below) must be running first.

## Hosted model by name, and questions across CSV files (built 2026-10-24, not yet run on Windows)

**Hosted model (H2).** A model may run hosted (OpenRouter) next to the local ones. It is used only when you name it:
`chainaim/auto` never picks it, and health data (PHI) sent to it is refused before anything leaves (mode
`ollama-cpu-8gb-hosted` sets `--auto-zones local --phi-zones local`). The answer says which zone served it
(`x-chainaim-zone`: local or public-api; the console shows it in the "Zone" cell).

```powershell
.	est-console\stack.ps1 -Rebuild gateway
.	est-console\switch-models.ps1 -To ollama-cpu-8gb-hosted                # asks for the OpenRouter key (hidden, never written)
npm run verify:openrouter                                                 # the key works and the model is allowed
.	est-consoleuyer.ps1 -Step e2e -Prefix $P -EnvFile $F -Model hosted/nemotron-nano-reasoning   # VERDICT gets "served by the requested model"
node test-console\console\server.ts --models-file config\local-models.cpu-hosted.json            # console: pick hosted/nemotron-nano-reasoning
```

**Questions across CSV files (X1).** The analyst (on this PC) finds which columns in different files hold the same
values (a claim number, a patient id, a payer), the model writes one SELECT from the headers only (no data), the
analyst runs it here with file access locked, and the model may word the answer from the result (masked by the
gateway). Numbers in the answer are checked against the result.

```powershell
test-console\start-analyst.cmd                                            # its own window; keep it open
cd servicesnalyst
$D = "C:\PRIV-AI-DATA\pm\clinic-a"                                     # CHANGE: a folder inside allowedRoots with 2+ CSV files
node scripts\make-fixtures.ts --out $D                                    # optional: synthetic production/collections/bank files
node scripts\ask.ts --folder $D --relations                               # how the files relate (no model)
node scripts\ask.ts --folder $D --question "For each payer, how many billed claims were paid and how much?"
node scripts\ask.ts --folder $D --question "same, local only" --model local/qwen2.5-3b
node scripts\ask.ts --folder $D --question "count" --sql 'SELECT count(*) FROM collections' --phrase none   # no model at all
```

Console: 02 Private chat, pick the data folder, "Ask across files" (or "Show how the files relate").

## Examples that ran in the 2026-10-24 session (copy and run)

Set `$P` and `$F` as above (the session used `XRPL_SEED_B01` and `C:\PRIV-AI-SECRETS\testnet2.env`).
Each run costs 0.01 RLUSD. Results are from BUILD_LOG.md; transactions are on testnet.xrpl.org.

**1. KYC note, fraud-check reply** (PII: name, e-mail, PAN, bank account, IFSC masked; answer addressed to the buyer by name)
```powershell
.\test-console\buyer.ps1 -Step e2e -Prefix $P -EnvFile $F -File .\rig\tenants\t03\docs\shipment-kyc.txt -Question "Address a short reply to the buyer by name. Should we accept the request to change the remittance account by phone? Why not?"
```
Result 02:34Z: END-TO-END PASSED 10/10, data class PII, "Dear Tomas Ridgeway" restored here, ledger validated tesSUCCESS, tx 8C780E36...79F7.

**2. Discharge note, patient and doctor by name** (health data: PHI, so only no-data-collection models)
```powershell
.\test-console\buyer.ps1 -Step e2e -Prefix $P -EnvFile $F -File .\rig\tenants\t02\docs\discharge-note.txt -Question "Who is the patient and who is the attending doctor? List the medicines in simple words."
```
Result 01:43Z: END-TO-END PASSED, data class PHI, "Meera Thalavan" and "Dr. Samuel Okafor" restored here, tx E8DC51C0...D4F4.
(The same run at 01:38Z was refused 422 "titled_name 1" before the R2 fix; nothing was sent or charged.)

**3. Supplier dispute, plain-language explanation**
```powershell
.\test-console\buyer.ps1 -Step e2e -Prefix $P -EnvFile $F -File .\rig\tenants\t01\docs\supplier-dispute.txt -Question "Explain this document in plain language: what each item means, and anything I should ask about."
```
Result 01:28Z: END-TO-END PASSED, data class PII, tx 8F76668F...CEE5 (the answer used no names, so restore was not exercised).

**4. Supplier dispute, refund letter using every masked value** (exercises restore of names and the account number)
```powershell
.\test-console\buyer.ps1 -Step e2e -Prefix $P -EnvFile $F -File .\rig\tenants\t01\docs\supplier-dispute.txt -Question "Draft the written refund request. Address it to Loomline's billing contact by name, sign it with our accounts payable lead's name and e-mail, and quote the supplier account number."
```
Result 01:32Z: names and account restored here, but VERDICT failed "gateway 3" (the gateway counted the client's placeholders); fixed in R1b. Not yet re-run after the fix.

**5. The same flow without the script** (what buyer.ps1 runs; from `services\paywall`)
```powershell
cd services\paywall
node scripts\e2e-private-ask.ts --file ..\..\rig\tenants\t03\docs\shipment-kyc.txt --env-file $F --seed-prefix $P --question "Address a short reply to the buyer by name. Should we accept the request to change the remittance account by phone? Why not?"
```

**6. Paid private ask only (no BEFORE/AFTER/VERDICT)**, as first run at 00:40Z (tx 2FCF14E9...180B); private-ask.ts reads the seed from the window, so set it for one command:
```powershell
cd services\paywall
Set-Item "Env:${P}_TESTNET" (node -e "process.loadEnvFile('$($F.Replace('\','/'))'); process.stdout.write(process.env['${P}_TESTNET'].trim())")
node scripts\private-ask.ts --file ..\..\rig\tenants\t01\docs\supplier-dispute.txt --url http://127.0.0.1:8080 --seed-prefix $P
Remove-Item "Env:${P}_TESTNET"
```

**7. Your own document**: plain .txt or .md, kept outside the repository; only the masked text leaves your PC.
```powershell
.\test-console\buyer.ps1 -Step e2e -Prefix $P -EnvFile $F -File "C:\PRIV-AI-DATA\mydoc.txt" -Question "Summarise this in three bullet points and list any amounts and dates."
```

## Quick start: every PowerShell command, in order

Open **Windows PowerShell** (a standalone window, not the VS Code terminal). Replace the three values
marked `CHANGE`: your folder, your wallet prefix (B02, B03, ...) and, in step F, your new address.
Run one block at a time and check its "Pass" line in the sections below before the next.

```powershell
# --- CHANGE these three -------------------------------------------------------------
$REPO   = "C:\SATHYA\CHAINAIM3003\mcp-servers\FINAGENTS\PRIVAI2\chainaim-router-private-ai-2"   # CHANGE: where you cloned
$PREFIX = "XRPL_SEED_B02"                                   # CHANGE: your own wallet prefix (B01 is taken)
$ENVF   = "C:/PRIV-AI-SECRETS/testnet2.env"                 # seed file, outside every repository
$SELLER = "rn5hSy7QvsrQLpGb3k5dp4h8Yrk9J7gBej"              # seller (pay-to) public address, 2026-10-24; ask the team if it changed
```

```powershell
# A. Prerequisites check (once per PC): Docker running, Ollama models present
docker info --format "{{.ServerVersion}}"
ollama pull qwen2.5:3b; ollama pull qwen2.5:1.5b-instruct; ollama pull deepseek-r1:1.5b
```

```powershell
# B. Get the code and install (once)
git clone https://github.com/chainaim-nisha/chainaim-router-private-ai-2.git $REPO
cd $REPO
npm --prefix services/paywall install
npm test
npm --prefix services/paywall test
```

```powershell
# C. Gateway key (ONLY if you have no ca-* containers yet; otherwise copy the existing file)
cd $REPO
docker ps -a --format "{{.Names}}"
if (-not (Test-Path test-console\local-gateway-key.txt)) { node -e "require('fs').writeFileSync('test-console/local-gateway-key.txt', require('crypto').randomBytes(24).toString('base64url'))" }
```

```powershell
# D. Build and start the local stack, local CPU models, then check it
cd $REPO
.\test-console\stack.ps1 -Rebuild all -PayTo $SELLER
.\test-console\switch-models.ps1 -To ollama-cpu-8gb
.\test-console\stack.ps1 -Check
```

```powershell
# E. Create your wallet (prints an address and a seed sEd...), then open the seed file
cd $REPO\services\paywall
node scripts\new-account.ts
New-Item -ItemType Directory -Force C:\PRIV-AI-SECRETS | Out-Null
notepad C:\PRIV-AI-SECRETS\testnet2.env
# In Notepad add one line:  XRPL_SEED_B02_TESTNET=sEd...   (your prefix + _TESTNET)
# Save as type "All files (*.*)", encoding UTF-8 (not BOM). Then:
cls
```

```powershell
# F. Show your address from the file (no seed printed); then fund it with TestNet XRP
cd $REPO\services\paywall
node -e "process.loadEnvFile('$ENVF'); import('xrpl').then(({Wallet}) => console.log('address:', Wallet.fromSeed(process.env['${PREFIX}_TESTNET'].trim()).classicAddress))"
$ADDR = "rYOUR_ADDRESS"                                     # CHANGE: paste the address printed above
Invoke-RestMethod -Method Post -Uri https://faucet.altnet.rippletest.net/accounts -ContentType application/json -Body (@{destination=$ADDR; userAgent='xrpl.js'} | ConvertTo-Json)
```

```powershell
# G. Open the RLUSD trust line (seed set for this one command, then removed)
cd $REPO\services\paywall
$env:XRPL_BUYER_SEED_TESTNET = node -e "process.loadEnvFile('$ENVF'); process.stdout.write(process.env['${PREFIX}_TESTNET'].trim())"
node scripts\trust-line.ts
Remove-Item Env:XRPL_BUYER_SEED_TESTNET
```

```powershell
# H. Buy 1 RLUSD with your XRP (quote first; nothing is spent above --max-xrp)
cd $REPO\services\paywall
node scripts\buy-rlusd.ts --env-file $ENVF --seed-prefix $PREFIX --amount 1 --max-xrp 13 --dry-run
node scripts\buy-rlusd.ts --env-file $ENVF --seed-prefix $PREFIX --amount 1 --max-xrp 13
```

```powershell
# I. Balances (read-only, no address typed)
cd $REPO\services\paywall
node scripts\balances.ts --title NOW --env-file $ENVF --buyer-seed-prefix $PREFIX --seller-from-paywall http://127.0.0.1:8080
```

```powershell
# J. The end-to-end paid private chat: BEFORE, masked ask + model + payment, AFTER, ledger check, VERDICT
cd $REPO\services\paywall
Remove-Item "Env:${PREFIX}_TESTNET" -ErrorAction SilentlyContinue      # so the file, not a leftover variable, is used
node scripts\e2e-private-ask.ts --file ..\..\rig\tenants\t03\docs\shipment-kyc.txt --env-file $ENVF --seed-prefix $PREFIX --question "Address a short reply to the buyer by name. Should we accept the request to change the remittance account by phone? Why not?"
```

```powershell
# K. After a reboot or Docker restart (then run J again)
cd $REPO
docker start ca-presidio ca-openrouter-stub ca-paywall
.\test-console\switch-models.ps1 -To ollama-cpu-8gb
.\test-console\stack.ps1 -Check
```

## Rules (read first)

- **A seed is a password.** Never paste it into chat, a commit, an issue or a log. This repository is public.
- Keep seeds in a file **outside every repository and every sync folder** (OneDrive, Dropbox), e.g.
  `C:\PRIV-AI-SECRETS\testnet2.env`. TestNet only: never a MainNet seed in a text file.
- One wallet per person/role. Use your own prefix: `XRPL_SEED_B02`, `XRPL_SEED_B03`, ... (B01 is taken).
- The seller (pay-to) wallet is not yours; you only pay it. You never need its seed.
- Use **Wi-Fi**, not the office wired LAN: its Sophos firewall re-signs TLS for the t54 facilitator and payments fail (402, "fetch failed").

## 0. Prerequisites (once per PC)

1. Git, Node.js 24 (22.22+ works), Docker Desktop (running: "Engine running"), Ollama.
2. Local models for the CPU mode:
   ```
   ollama pull qwen2.5:3b
   ollama pull qwen2.5:1.5b-instruct
   ollama pull deepseek-r1:1.5b
   ```
3. Clone and install (repository root = the folder with `package.json`):
   ```
   git clone https://github.com/chainaim-nisha/chainaim-router-private-ai-2.git
   cd chainaim-router-private-ai-2
   npm --prefix services/paywall install
   npm test
   npm --prefix services/paywall test
   ```
   Pass: both end with `fail 0` (gateway 319+, paywall 132+ on 2026-10-24).

## 1. Local stack (once per PC; again after a Docker restart)

1. Gateway key file `test-console\local-gateway-key.txt` (gitignored). **If you have no ca-* containers yet**, make it once:
   ```
   node -e "require('fs').writeFileSync('test-console/local-gateway-key.txt', require('crypto').randomBytes(24).toString('base64url'))"
   ```
   If containers already exist, do NOT regenerate it (RUN-ON-ANOTHER-PC.md trap 3); copy the existing file instead.
2. Build and start the containers from this repository (Presidio is ~1.6 GB the first time). The pay-to is the
   seller's public address (ask the team; on 2026-10-24 it was `rn5hSy7QvsrQLpGb3k5dp4h8Yrk9J7gBej`):
   ```
   .\test-console\stack.ps1 -Rebuild all -PayTo rSELLER_ADDRESS
   .\test-console\switch-models.ps1 -To ollama-cpu-8gb
   ```
   Pass: `switch-models` ends with `Answer from local/qwen2.5-3b: The capital of India is New Delhi.`
   (`stack.ps1` reports a FAIL "runs an OLDER build" for ca-gateway just before switch-models replaces it: expected.)
3. Check at any time (changes nothing; every FAIL names its fix):
   ```
   .\test-console\stack.ps1 -Check
   ```
   Pass for ca-paywall: `quotes 0.01 RLUSD for chat`, `quote network xrpl:1`, `pays to r...`.
   After a reboot/Docker restart: `docker start ca-presidio ca-openrouter-stub ca-paywall`, then `switch-models.ps1 -To ollama-cpu-8gb`.

## 2. Your buyer wallet (once per person)

All commands from `services\paywall`. Replace `B02` with your prefix.

1. **Create** (offline; prints an address and a family seed `sEd...`):
   ```
   cd services\paywall
   node scripts\new-account.ts
   ```
2. **Save the seed** in `C:\PRIV-AI-SECRETS\testnet2.env`, one line per wallet, no spaces, no quotes:
   ```
   XRPL_SEED_B02_TESTNET=sEd...
   ```
   ```
   New-Item -ItemType Directory -Force C:\PRIV-AI-SECRETS | Out-Null
   notepad C:\PRIV-AI-SECRETS\testnet2.env
   ```
   Notepad: Save as type **All files (\*.\*)**, name `testnet2.env`, encoding **UTF-8** (not "with BOM", not UTF-16).
   Then `cls` to clear the seed from the screen. A line starting with `#` is a comment (you may keep `# address r...`).
3. **Check the file** (prints the address only):
   ```
   node -e "process.loadEnvFile('C:/PRIV-AI-SECRETS/testnet2.env'); import('xrpl').then(({Wallet}) => console.log('address:', Wallet.fromSeed(process.env.XRPL_SEED_B02_TESTNET.trim()).classicAddress))"
   ```
   `Cannot read properties of undefined (reading 'trim')` = the line name is wrong, or Notepad added a BOM / `.txt`.
4. **Fund with TestNet XRP** (faucet API; the web faucet page may not work), using your address:
   ```
   Invoke-RestMethod -Method Post -Uri https://faucet.altnet.rippletest.net/accounts -ContentType application/json -Body (@{destination='rYOUR_ADDRESS'; userAgent='xrpl.js'} | ConvertTo-Json)
   ```
   Pass: an `account` block with your `classicAddress` (100 XRP on 2026-10-24).
5. **Open the RLUSD trust line** (trust-line.ts reads `XRPL_BUYER_SEED_TESTNET`; set it from the file for this one command, then remove it):
   ```
   $env:XRPL_BUYER_SEED_TESTNET = node -e "process.loadEnvFile('C:/PRIV-AI-SECRETS/testnet2.env'); process.stdout.write(process.env.XRPL_SEED_B02_TESTNET.trim())"
   node scripts\trust-line.ts
   Remove-Item Env:XRPL_BUYER_SEED_TESTNET
   ```
   Pass: `trust line to RLUSD opened; transaction ...`.
6. **Buy RLUSD with your XRP** on the XRPL exchange (AMM; no browser wallet, no faucet). Quote first, then buy.
   On 2026-10-24, 1 RLUSD cost ~12.15 TestNet XRP; 1 RLUSD pays 100 chats at 0.01:
   ```
   node scripts\buy-rlusd.ts --env-file C:/PRIV-AI-SECRETS/testnet2.env --seed-prefix XRPL_SEED_B02 --amount 1 --max-xrp 13 --dry-run
   node scripts\buy-rlusd.ts --env-file C:/PRIV-AI-SECRETS/testnet2.env --seed-prefix XRPL_SEED_B02 --amount 1 --max-xrp 13
   ```
   Pass: `bought 1 RLUSD; transaction ...` and `RLUSD balance after: 1`. If the quote is above `--max-xrp`, nothing is spent: raise it or buy less.
7. **Balances** (read-only; no address typed):
   ```
   node scripts\balances.ts --title NOW --env-file C:/PRIV-AI-SECRETS/testnet2.env --buyer-seed-prefix XRPL_SEED_B02 --seller-from-paywall http://127.0.0.1:8080
   ```

## 3. The end-to-end paid private chat (each time)

From `services\paywall`, stack up (section 1), on Wi-Fi:
```
node scripts\e2e-private-ask.ts --file ..\..\rig\tenants\t03\docs\shipment-kyc.txt --env-file C:/PRIV-AI-SECRETS/testnet2.env --seed-prefix XRPL_SEED_B02 --question "Address a short reply to the buyer by name. Should we accept the request to change the remittance account by phone? Why not?"
```
Other synthetic documents: `..\..\rig\tenants\t01\docs\supplier-dispute.txt`, `..\..\rig\tenants\t02\docs\discharge-note.txt` (health data: PHI).
Options: `--question`, `--max-amount 0.05` (refuse a higher price before signing), `--max-tokens 1024`,
`--settle-wait-sec 30`, `--no-show-sent`, `--no-show-answer`. Each run costs the quoted price (0.01 RLUSD).

What the output proves, in order:
| Section | Look for |
|---|---|
| BEFORE | buyer and seller XRP / RLUSD from the validated ledger, and the quote (price, network xrpl:1, seller) |
| WORK | `masked here, now: ...`; `--- what leaves this computer (masked) ---` holds only `<C_...>` placeholders; `HTTP 200`, `x-chainaim-model`, `x-chainaim-data-class`, `x-chainaim-unresolved: 0`; `payment success true; transaction ...`; the answer with the real names put back on your PC |
| AFTER | buyer RLUSD -0.01, seller +0.01; then `ledger: <hash> validated, tesSUCCESS, buyer -> seller, delivered 0.01 RLUSD, fee N drops` |
| VERDICT | 10 PASS lines and `END-TO-END PASSED` (exit code 0) |

## 4. Troubleshooting (all seen on 2026-10-24)

| Symptom | Cause / fix |
|---|---|
| `error during connect ... dockerDesktopLinuxEngine` | Docker Desktop not running: start it, wait for "Engine running". |
| switch-models: `Missing ...local-gateway-key.txt` | section 1 step 1. |
| switch-models: `Ollama does not have <model>` | `ollama pull <model>` (section 0). |
| switch-models stuck at "Waiting for the gateway..." | Presidio stopped: `docker start ca-presidio ca-openrouter-stub ca-paywall`. |
| Console shows "Send ($10000)" / stack -Check FAIL "Algorand-era setting" | stale paywall image: `stack.ps1 -Rebuild paywall`. |
| `HTTP 422 ... titled_name 1` (or other kinds) | the gateway's final check found something that still looks personal; nothing was sent or charged. Report the kinds. |
| `x-chainaim-unresolved` > 0 / names not put back | a model wrote placeholders in an odd form; report the run (fix R1/R1b covers the known forms). |
| 402 with `fetch failed` | wired LAN (Sophos): switch to Wi-Fi. |
| `XRPL_SEED_B02_TESTNET is required` | wrong `--seed-prefix`, wrong `--env-file`, or the line is misspelled. |
| A seed set earlier in the window is used instead of the file | Node does not overwrite a variable already set: `Remove-Item Env:XRPL_SEED_B02_TESTNET` or open a new window. |
| `--file ...: only .txt and .md files` | pass a real path to a .txt/.md file. |
| Crossmark "Connection Instability" | not needed for this flow; use section 2 step 6 to get RLUSD. |
