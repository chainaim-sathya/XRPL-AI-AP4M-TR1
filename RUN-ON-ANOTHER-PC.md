# Run the ChainAim test console on another Windows PC

Start to finish: an empty PC to the test console UI at <http://127.0.0.1:8730/>.

Every command is **PowerShell**, run from the repository folder, one at a time.
Where a command must NOT be run in the VS Code integrated terminal, it says so.

Two other guides overlap with this one: `SETUP.md` (tests and stand-ins) and
`docs/setup-end-to-end.md` (the original single-PC guide). This file is the
practical path plus the four traps that cost a day of debugging on 2026-10-17.

---

## What you end up with

| Part | Container | Reached at | What it is |
|---|---|---|---|
| Presidio | `ca-presidio` | private only | Finds personal, health and card data |
| OpenRouter stand-in | `ca-openrouter-stub` | <http://127.0.0.1:5004> | Fake models that echo, plus a record of what was sent |
| Gateway | `ca-gateway` | <http://127.0.0.1:8720> | Scan, mask, private chat (needs a key) |
| Paywall | `ca-paywall` | <http://127.0.0.1:8080> | Public x402 front; answers 402 until paid |
| Test console | none (Node process) | **<http://127.0.0.1:8730>** | The UI that drives all of the above |

All four containers share the Docker network `chainaim-test`. The gateway
reaches Presidio as `presidio.railway.internal`; the paywall reaches the
gateway as `gateway.railway.internal` — the same names Railway uses.

Port 8080 is **not** a second UI. It is the paywall API; `GET /` returns a
one-page landing used by the x402 Bazaar to read the merchant name.

---

## Read this first: four traps

1. **`.env` is never read.** Nothing in this project loads it. The gateway
   Dockerfile does not copy it and `main.ts` reads `process.env` only.
   `.env.example` is documentation of variable NAMES. Putting an OpenRouter
   key in `.env` has no effect whatsoever.
2. **The VS Code integrated terminal corrupts `Read-Host -AsSecureString`
   pastes** into a single control character. Symptom: one `*` at the prompt,
   then every chat attempt fails with `network_error` at `ms: 0` in the
   ledger. Use a standalone PowerShell window for anything involving a key.
3. **Never regenerate `test-console/local-gateway-key.txt` once `ca-gateway`
   exists.** The console reads the file; the container holds a copy baked in
   at `docker run` time. Regenerating desynchronises them and the UI shows
   `HTTP 401: missing or invalid gateway API key`.
4. **Containers do not auto-start.** None has a restart policy, so after a
   reboot or a Docker restart you run `test-console\start.cmd` again.

---

## 1. Prerequisites

- **Git**
- **Node.js 24** (22.22 or newer works). The gateway runs TypeScript directly.
- **Docker Desktop**, running, with **at least 4 GB** of memory available.
  Presidio alone needs about 2 GB and its image is about 1.6 GB.
- Free ports **5004, 8080, 8720, 8730**
- An **Algorand TestNet address** for the paywall (step 5 makes one)
- Optional, for real model answers: an **OpenRouter account and API key**

Check:

```powershell
node --version
```

```powershell
docker version --format "{{.Server.Version}}"
```

The second prints a version only when Docker Desktop is running.

---

## 2. Get the code

```powershell
git clone https://github.com/chainaimdev/chainaim-router.git
```

```powershell
cd chainaim-router
```

```powershell
npm --prefix services/paywall install
```

The gateway needs no packages. The paywall needs its own install for the
`pay.ts` and `new-account.ts` scripts; the paywall image installs its own copy.

Optional health check of the code, about 5 seconds each:

```powershell
npm test
```

```powershell
npm run test:paywall
```

---

## 3. Build the three images

The `:test` tags are what the test-console scripts expect. Presidio is about
1.6 GB and the first build takes several minutes.

```powershell
docker build -t chainaim-presidio:test services/presidio
```

```powershell
docker build -t chainaim-gateway:test -f services/gateway/Dockerfile .
```

```powershell
docker build -t chainaim-paywall:test services/paywall
```

The gateway build uses the repository root as its context — run it from the
repository folder, not from `services/gateway`.

---

## 4. Network and the local gateway key

```powershell
docker network create chainaim-test
```

Make the shared key **once**. It never leaves this PC and git ignores it:

```powershell
node -e "require('fs').writeFileSync('test-console/local-gateway-key.txt', require('crypto').randomBytes(24).toString('base64url'))"
```

> Do not run that again once `ca-gateway` exists. See trap 3.

Load it into this window. Every later step in this session needs it:

```powershell
$env:CHAINAIM_GATEWAY_KEY = (Get-Content -Raw test-console\local-gateway-key.txt).Trim()
```

---

## 5. An Algorand TestNet address for the paywall

Skip if you already have one. It must be 58 capital letters and digits.

```powershell
cd services/paywall
```

```powershell
node scripts/new-account.ts
```

```powershell
cd ../..
```

It prints an address and 25 words. Save the words in a password manager and
clear the terminal. Only the address goes into the next step. Nothing is ever
paid by the console, so this account needs no funding.

---

## 6. Start Presidio, the stand-in and the paywall

```powershell
docker run -d --name ca-presidio --network chainaim-test --network-alias presidio.railway.internal chainaim-presidio:test
```

The stand-in mounts the repository's `scripts` folder and the console's `spy`
folder. It must exist even if you only ever use real models, because the
console and `start.cmd` expect it:

```powershell
docker run -d --name ca-openrouter-stub --network chainaim-test --network-alias openrouter-stub -p 127.0.0.1:5004:5004 -v "${PWD}\scripts:/app/scripts:ro" -v "${PWD}\test-console\spy:/spy:ro" node:24-slim node /spy/spy-openrouter.ts
```

> Run this in PowerShell, not Git Bash. Git Bash rewrites `/spy/...` into a
> Windows path and the container exits immediately.

Start the paywall with the stack script (it builds nothing unless asked, sets the
XRPL settings and the gateway key from `test-console/local-gateway-key.txt`):

```powershell
.\test-console\stack.ps1 -Recreate paywall -XrplNetwork testnet -PayTo YOUR_TESTNET_ADDRESS
```

`YOUR_TESTNET_ADDRESS` is the XRPL pay-to address (r...) from step 5. The old
Algorand command (`AVM_PAY_TO`, `X402_NETWORK`) no longer works: the paywall
reads `XRPL_NETWORK` and `XRPL_PAY_TO_TESTNET`.

Check the whole stack at any time (changes nothing; every FAIL names its fix):

```powershell
.\test-console\stack.ps1 -Check
```

Without the stack script (manual `docker run`; use this when you need `PAYWALL_PHASE_LOG=on`):

Replace `YOUR_XRPL_PAY_TO` with the paywall's XRPL TestNet address (`r...`, funded and with an RLUSD trust line, see MANUAL_SETUP.md). The payment rail is XRPL/RLUSD since 2026-10-13; the old `AVM_PAY_TO` / `X402_NETWORK` variables are retired:

```powershell
docker run -d --name ca-paywall --network chainaim-test -e XRPL_NETWORK=testnet -e XRPL_PAY_TO_TESTNET=YOUR_XRPL_PAY_TO -e GATEWAY_URL=http://gateway.railway.internal:8700 -e CHAINAIM_GATEWAY_KEY -e PAYWALL_PHASE_LOG=off -p 127.0.0.1:8080:8080 chainaim-paywall:test
```

`PAYWALL_PHASE_LOG=on` adds each settled payment's capacity, verify, gateway and settle milliseconds to its `payment_settled` log line (P14); numbers only.

The bare `-e CHAINAIM_GATEWAY_KEY` passes the value from step 4's variable.
If that variable is empty, the paywall gets the wrong key and the UI later
fails with 401.

---

## 7. Start the gateway

Do not write a `docker run` for this one — the switch script owns the
container and its flags.

```powershell
test-console\use-stand-in.cmd
```

It creates `ca-gateway` with the key from step 4, waits for Presidio (up to a
minute), then asks a test question.

Expected:

```
Waiting for the gateway...
Test question: What is the capital of India?
Answer from stub/charlie-8b:free: echo: What is the capital of India?
The stand-in model is back on.
```

---

## 8. Verify before opening the browser

```powershell
curl.exe -s http://127.0.0.1:8720/healthz
```

```powershell
curl.exe -s http://127.0.0.1:8080/healthz
```

Both must print `{"status":"ok"}`. The paywall's check proxies through the
gateway, which checks Presidio, so a clean second result means all three are
up and the keys match.

If the gateway is silent, it is still doing the Presidio handshake. Docker
publishes port 8720 the moment the container is created, but the gateway does
not bind until Presidio answers and passes a detection check (up to 120 s).
Wait and repeat.

---

## 9. Start the UI

```powershell
test-console\start.cmd
```

Open **<http://127.0.0.1:8730/>**. Keep that window open; closing it stops the
console but leaves the containers running.

| Section | What it does |
|---|---|
| 1. Scan and mask | Shows what Presidio found and what it would replace |
| 2. Private chat | Masks, routes, restores your real values in the answer |
| 3. Payment | Unpaid call through the paywall, shows the 402 and its price |
| 4. Ledger | The gateway's last routing decisions |

Things to try, all synthetic:

- Section 1: `Patient Jane Roe, MRN 991122, was diagnosed with diabetes.`
  Expect a name, a record number, a health term, and data class PHI.
- Section 3: expect 402 with a price, network, pay-to address and challenge tag.

In stand-in mode, section 2 echoes your text back. Scan, mask, the PHI
classification, the data-collection policy, the 402 quote and the ledger are
all fully real regardless.

---

## 10. Optional: real model answers

Scan and mask never call OpenRouter. Only section 2 needs this.

### 10.1 The account

Sign up at <https://openrouter.ai>. Free models need no card.

Free-model limits depend on credits ever purchased:

| Credits bought | Per minute | Per day |
|---|---|---|
| under $10 | 20 | 50 |
| $10 or more | 20 | 1,000 |

At <https://openrouter.ai/settings/privacy>, turn on **"Enable free endpoints
that may train on inputs"**. With it off, OpenRouter answers
`404 No endpoints found matching your data policy` and no model is usable.
ChainAim masks all personal data before any model sees it; text classed as
health data is additionally restricted to providers with
`data_collection: deny`, whatever the account switches say.

Create a key at <https://openrouter.ai/keys>. Name it for where it lives, set
a small credit limit.

### 10.2 Load the key — standalone PowerShell only

Open a **standalone PowerShell window** (Win key, type PowerShell, Enter).
**Not** the VS Code terminal. See trap 2.

```powershell
cd C:\path\to\chainaim-router
```

```powershell
$env:OPENROUTER_API_KEY = (Read-Host "key").Trim()
```

Paste at the prompt. The key is briefly visible; run `cls` afterwards.

**Verify before rebuilding anything.** This prints no part of the key:

```powershell
"len {0} ascii {1} prefix {2}" -f $env:OPENROUTER_API_KEY.Length, ($env:OPENROUTER_API_KEY -match '^[!-~]+$'), $env:OPENROUTER_API_KEY.StartsWith('sk-or-')
```

Expect roughly `len 73 ascii True prefix True`. Anything else means the paste
was mangled — fix it here, not after a container rebuild.

Then confirm OpenRouter accepts it:

```powershell
try { (Invoke-WebRequest -UseBasicParsing -Uri https://openrouter.ai/api/v1/key -Headers @{authorization="Bearer $env:OPENROUTER_API_KEY"}).StatusCode } catch { "STATUS " + $_.Exception.Response.StatusCode.value__ }
```

Expect `200`. A `401` means the key is wrong or deleted — stop and fix that.

### 10.3 Switch the gateway

In the same window:

```powershell
test-console\use-real-models.cmd
```

It prints `Using OPENROUTER_API_KEY from your environment`, skips the prompt,
recreates `ca-gateway` with the key, and asks the test question. Expect an
answer from a model id ending `:free`.

If the test question fails right after a run with a bad key, failed models are
in a 5-minute cooldown (`--cooldown-ms 300000`). Wait and try again in the UI
before concluding anything is broken.

The key is never written to disk. While real mode is on, Docker holds it in
the container's settings, readable by anyone who can run `docker inspect` on
this PC. `use-stand-in.cmd` removes it.

In real mode the two "what left ChainAim" panels stay empty — they record the
stand-in only. The ledger still records every request.

---

## 11. Everyday use

| To | Run |
|---|---|
| Start everything and the console | `test-console\start.cmd` |
| Use real models | `test-console\use-real-models.cmd` |
| Back to the stand-in, key removed | `test-console\use-stand-in.cmd` |
| Stop the containers | `docker stop ca-paywall ca-gateway ca-openrouter-stub ca-presidio` |
| See what the gateway is doing | `docker logs ca-gateway` |
| Read the last routing decisions | `docker exec ca-gateway sh -c "tail -n 3 /data/ledger/*.jsonl"` |

The ledger lives in the Docker volume `chainaim-test-ledger` and survives mode
switches. Remove it with `docker volume rm chainaim-test-ledger` after
removing the gateway container.

---

## 12. Troubleshooting

| What you see | Cause and fix |
|---|---|
| UI shows `HTTP undefined:` with no message | The console could not reach the gateway at all. Run `curl.exe -s -X POST http://127.0.0.1:8730/gateway/scan -H "content-type: application/json" -d "{\"text\":\"hi\"}"` to see the real message the page discards. |
| `{"error":"fetch failed"}` from that command | `ca-gateway` is not up, or is still doing the Presidio handshake. Check `docker ps -a --filter "name=ca-"`. |
| `HTTP 401: missing or invalid gateway API key` | The key file and the container have drifted. Run `test-console\use-stand-in.cmd` to recreate the gateway from the current file. Then check the paywall with `curl.exe -s http://127.0.0.1:8080/healthz`. |
| Ledger shows `"outcome":"network_error","ms":0` | Not a network fault. A 0 ms throw means `fetch` failed before sending — almost always a corrupted API key making an invalid HTTP header. See trap 2. |
| Ledger shows `key_rejected` | A real 401 from OpenRouter. Verify the key with the command in 10.2. |
| Ledger shows `data_policy_unavailable` | No free model currently has a no-collection provider. Expected for PHI; the request is refused and not charged. |
| Ledger shows `rate_limited_account` | 20/min or 50/day free cap reached. |
| `every model tried failed` right after fixing a key | Cooldown from the earlier failures. Wait 5 minutes. |
| `docker: ... name is already in use` | `docker rm -f <name>` and run the command again. |
| The stand-in container exits at once | The mounts did not resolve. Run that command in PowerShell from the repository folder. |
| `EADDRINUSE` starting the console | Port 8730 is taken. Close the old console window. |
| Gateway fails Presidio's start-up check | Give Docker more memory. Presidio needs about 2 GB. |

---

## 13. Clean removal

```powershell
docker rm -f ca-paywall ca-gateway ca-openrouter-stub ca-presidio
```

```powershell
docker volume rm chainaim-test-ledger
```

```powershell
docker network rm chainaim-test
```
