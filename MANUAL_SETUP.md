# MANUAL SETUP

Steps the owner must do by hand. Append-only.

## 2026-10-13 — before the XRPL migration build can continue

1. **Free disk space on C:.** The drive is at 100% (about 137 MB free). `services/paywall` needs roughly 300 MB for `npm ci`, and the XRPL packages need more. The npm cache at `C:\Users\Admin\AppData\Local\npm-cache` holds 5.2 GB and can be emptied with `npm cache clean --force`.
2. **Make `*.t54.ai` reachable with a trusted certificate.** The Sophos firewall re-signs TLS for `xrpl-facilitator-testnet.t54.ai`, `xrpl-facilitator-mainnet.t54.ai` and `xrpl-x402.t54.ai`. Either exclude these hosts from HTTPS decryption, or export the Sophos root CA to a `.pem` file and point Node at it with `NODE_EXTRA_CA_CERTS`. Check with: `node -e "fetch('https://xrpl-facilitator-testnet.t54.ai/supported').then(r=>r.text()).then(console.log)"`.
3. **Choose the browser wallet** for ARCH-016: Xaman, GemWallet or Crossmark.

## 2026-10-13 — paywall on XRPL/RLUSD (ARCH-010, ARCH-011, ARCH-012)

Items 1 above (disk space) is done. Item 2 (`*.t54.ai` behind the Sophos certificate) is still open.

### Environment variables the paywall service reads (`services/paywall/src/config.ts`)

| Variable | Required | Default | What it is |
|---|---|---|---|
| `XRPL_NETWORK` | no | `testnet` | `testnet` or `mainnet`. Only that network's variables below are read and checked. |
| `XRPL_PAY_TO_TESTNET` / `XRPL_PAY_TO_MAINNET` | yes, for the chosen network | none | The XRPL classic address (`r...`) every route pays. Checksum-verified at start. Must not be the buyer account. |
| `RLUSD_ISSUER_TESTNET` | no | `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV` | RLUSD issuer on TestNet. |
| `RLUSD_ISSUER_MAINNET` | yes on mainnet | none, on purpose | Copy it from Ripple's documentation at deploy time (spec section 3.4). |
| `XRPL_CAIP2_TESTNET` / `XRPL_CAIP2_MAINNET` | no | `xrpl:1` / `xrpl:0` | CAIP-2 network id. |
| `FACILITATOR_URL_TESTNET` / `FACILITATOR_URL_MAINNET` | no | `https://xrpl-facilitator-testnet.t54.ai` / `https://xrpl-facilitator-mainnet.t54.ai` | The t54 x402 facilitator. |
| `RLUSD_CURRENCY_CODE` | no | `524C555344000000000000000000000000000000` | 40 hex characters. |
| `XRPL_SOURCE_TAG` | no | `804681468` | Put on every quoted price; a 32-bit number. |
| `XRPL_MAX_TIMEOUT_SECONDS` | no | `600` | How long a quoted price and its invoice stay payable. |

Unchanged: `CHAINAIM_GATEWAY_KEY`, `GATEWAY_URL`, `PUBLIC_BASE_URL`, `PRICE_SCAN`, `PRICE_MASK`, `PRICE_CHAT`, `GATEWAY_TIMEOUT_MS`, `PORT`, `HOST`.

Retired, remove from Railway: `AVM_PAY_TO`, `X402_NETWORK`, `FACILITATOR_URL`.

### Environment variables only the scripts read (`services/paywall/scripts/xrpl.ts`) — never set on a service, never committed

| Variable | Required | Default | What it is |
|---|---|---|---|
| `XRPL_BUYER_SEED_TESTNET` / `XRPL_BUYER_SEED_MAINNET` | yes, to pay or to run `trust-line.ts` / `send-xrp.ts` | none | Family seed (`s...`) of the account that signs. Replaces `AVM_MNEMONIC`. |
| `XRPL_WS_URL_TESTNET` | no | `wss://s.altnet.rippletest.net:51233/` | XRPL WebSocket server. |
| `XRPL_WS_URL_MAINNET` | yes on mainnet | none | XRPL WebSocket server for MainNet. |

### Owner steps on TestNet (spec Stage 2 and Stage 3) — not done by the agent

1. Make two accounts, buyer and pay-to: `node scripts/new-account.ts` twice, in `services/paywall`. Save each seed in a password manager.
2. Fund both with TestNet XRP from the XRPL TestNet faucet: `https://xrpl.org/resources/dev-tools/xrp-faucets`.
3. Open an RLUSD trust line on each: put that account's seed in `XRPL_BUYER_SEED_TESTNET` and run `node scripts/trust-line.ts`.
4. Get TestNet RLUSD into the buyer account from Ripple's RLUSD TestNet faucet, `https://tryrlusd.com/` (the address Ripple's RLUSD developer documentation links to).
5. Set `XRPL_PAY_TO_TESTNET` on the paywall, start it, then run `node scripts/pay.ts --dry-run URL` and `node scripts/pay.ts URL '{"text":"..."}'` with the buyer seed. A settled payment here is the proof the agent could not produce (see STATE.md).

## 2026-10-13 — web page on Crossmark (ARCH-015, ARCH-016)

No new environment variable: `services/web` still reads only `PAYWALL_URL`, `PORT` and `HOST`.

1. Install the Crossmark browser extension (`https://crossmark.io`) and make or import a TestNet account in it. This is the buyer; do not use the pay-to account.
2. Fund it with TestNet XRP, open its RLUSD trust line and get TestNet RLUSD, as in the owner steps above.
3. Start the paywall and the web app, open the page, click **Connect Crossmark**, mask a message and press **Execute**. This is the first time the Crossmark path runs for real; the agent could only test it with a stand-in.
4. On Vercel, redeploy `services/web` so the new `public/wallet.js` and security headers go live.
5. Review the disclaimer sentence in `services/web/public/index.html` that now names "Ripple, the XRPL Foundation".

## 2026-10-21 — owner steps on TestNet: done (details in STATE.md, section of the same date)

- Item 2 of the first list (`*.t54.ai` behind Sophos): not needed on this PC's network; the facilitator answered `/supported` from the host and from `ca-paywall`.
- "Owner steps on TestNet" 1 to 5: done. payTo `rn5hSy7QvsrQLpGb3k5dp4h8Yrk9J7gBej`, buyer `rMosbGSCHTWnZmdgyhVETxSDRdPnormKxR`; both funded and with RLUSD trust lines. First settled payment: tx `E55B67292C6DAFE7CC07060477FA5E65E38DCFCE8257AD8B0D5590EF8BE8400A`.
- Step 2 (faucet): the web page did not fund an existing address; use the faucet API instead, one address at a time:
  `Invoke-RestMethod -Method Post -Uri https://faucet.altnet.rippletest.net/accounts -ContentType application/json -Body (@{destination='r...'; userAgent='xrpl.js'} | ConvertTo-Json)`
- Step 4 (RLUSD): tryrlusd.com sent RLUSD to the owner's own account; 1 RLUSD was then sent to the buyer from Crossmark (open the RLUSD token, then its Send, so the amount is RLUSD and not XRP).
- Entering a seed in PowerShell: use a standalone PowerShell window and paste with a right-click. In the VS Code terminal, or with Ctrl+V at a hidden prompt, the paste becomes one control character (one `*` at the prompt).
- Still to do: "web page on Crossmark" steps 1 to 5 (the page itself has not been run).

## 2026-10-23 — test rig (L0): three buyer tenants paying in a loop

New script-only variables (never set on a service, never committed), read by `services/paywall/scripts/rig.ts` through `scripts/xrpl.ts`: `XRPL_SEED_T01_TESTNET`, `XRPL_SEED_T02_TESTNET`, `XRPL_SEED_T03_TESTNET`, one family seed per tenant in `rig/tenants/`. `pay.ts` and `private-ask.ts` take `--seed-prefix XRPL_SEED_T01` to pay as one tenant.

Owner steps, in `services/paywall`, once per tenant (t01, t02, t03); none of them is done by the agent:
1. `node scripts/new-account.ts`: save the seed in the password manager and in the repository `.env` as `XRPL_SEED_T0n_TESTNET`. Each tenant needs its own account, separate from payTo and from the other tenants.
2. Fund the address with TestNet XRP through the faucet API (see 2026-10-21 above).
3. Open its RLUSD trust line: set `XRPL_BUYER_SEED_TESTNET` to that tenant's seed for this one command and run `node scripts/trust-line.ts`.
4. Send it RLUSD from the owner's Crossmark account (open the RLUSD token, then Send). The rig spends at most `--max-spend` (default 0.2 RLUSD) per tenant per run.
5. With the paywall running: `node scripts/rig.ts --url http://127.0.0.1:8080 --dry-run`, then `node scripts/rig.ts --url http://127.0.0.1:8080 --calls 10`. The pass for L0 is "settled 30 of 30" and 30 `payment_settled` lines from three payers in `docker logs ca-paywall`.

## 2026-10-23 — buyer agents (L1): Strands agents on Amazon Bedrock

New code: `services/paywall/scripts/agent.ts` (command line), `agent-core.ts` (tool, session, agent), `private-ask-core.ts` (masking/paying path shared with `private-ask.ts`). New dev dependencies: `@strands-agents/sdk` 1.20.0, `zod` 4.6.7. Tenant documents (synthetic): `rig/tenants/<id>/docs/`.

No new variable is read by this code. The agent's language model is Amazon Bedrock, reached with the AWS SDK's usual credential chain (`AWS_PROFILE`, or `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`, or SSO). Never put AWS keys in `.env` or any committed file. Tenant seeds are the L0 ones (`XRPL_SEED_T0n_TESTNET`).

Owner steps, none done by the agent:
1. In `services/paywall`: `npm install` (adds the Strands SDK and zod), then `npm test`. The pass is 90 of 90.
2. AWS: an identity on this PC (profile or SSO) allowed `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` in the region passed to `--region` (default `us-east-1`). The agent's default model is the inference profile `global.anthropic.claude-sonnet-4-6`; if Bedrock answers AccessDenied or "model not found", open Bedrock in the AWS console for that region and enable access to the Anthropic model, or pass another model you have with `--model-id`.
3. Dry run (calls Bedrock, pays nothing, sends nothing to ChainAim): `node scripts/agent.ts --tenant t02 --dry-run --prompt "What does my discharge note say about follow-up?"`.
4. Paid run, stack up, on Wi-Fi (Sophos, see 2026-10-23 L0): `node scripts/agent.ts --tenant t02 --url http://127.0.0.1:8080 --prompt "What does my discharge note say about follow-up?"`. The pass is one `[chainaim_private_ask] discharge-note.txt: answered, 0.01 RLUSD, tx ...` line, the answer with the real names shown on screen, and one `payment_settled` line in `docker logs ca-paywall`. The paid chat needs the gateway's chat path to answer (the local `ca-openrouter-stub` or a real model).

## 2026-10-24 — M1: masking before the model (gateway)

No new environment variable. New gateway flags, all with defaults: `--extra-entities all`, `--residual-guard on`, `--residual-checks all`, `--residual-min-digits 9`. Needs the real Presidio running (`ca-presidio`); the Presidio image itself is unchanged (the new recognizers are sent with each request).

Owner steps, none done by the agent:
1. In `chainaim-router-private-ai-2`: `npm test`. The pass is `pass 292 fail 0`.
2. Rebuild the gateway image from this folder and recreate `ca-gateway` (same commands as in RUN-ON-ANOTHER-PC.md). Its start-up line must show `extra-entities=bank_account,titled_name,street_address,dob,location residual=digits,spaced_digits,intl_phone,email,titled_name/9`. If it stops with "did not detect X in the start-up test sentence", note X; restart with `--extra-entities` minus that group and report it.
3. With the stand-in model (`use-stand-in.cmd`), send the sample bank statement from the console's private chat. The pass is: the spy's "what left" view holds no name, account number or address from the statement, and the ledger line holds no value. A 422 naming kinds (for example `digits 1`) means masking missed a value and nothing was sent; report the kinds.

## 2026-10-24 — M1d: synthetic values in place of the real statement values

No new variable, flag or service. Owner steps, none done by the agent:
1. In `chainaim-router-private-ai-2` on Windows: `npm test`. The pass is `pass 296 fail 0`.
2. Rebuild the gateway image (`docker build -t chainaim-gateway:test -f services/gateway/Dockerfile .`) and `switch-models.ps1 -To ollama-cpu-8gb`. The pass is a gateway start-up with no "did not detect ... in the start-up test sentence" error (the canary now uses the synthetic account and name).
3. Commit the 7 files plus BUILD_LOG/STATE/MANUAL_SETUP, tag `v1.0.3`, `git push private2 main --tags` (never `origin`).
4. Decide whether to rewrite history so v1.0.2 and earlier commits no longer hold the real values (destructive: rewrites tags, needs a force push).

## 2026-10-24 — S1: rebuild the paywall with stack.ps1

No new variable. Owner steps, in PowerShell from the repository folder, Docker Desktop running:
1. `.\test-console\stack.ps1 -Check`: expect FAIL lines for ca-paywall (Algorand settings, quote 10000) and WARN "image source unknown" for the hand-built images. Nothing changes.
2. `.\test-console\stack.ps1 -Rebuild paywall`: builds `chainaim-paywall:test` from `services/paywall`, recreates `ca-paywall` on TestNet paying to `rn5hSy7QvsrQLpGb3k5dp4h8Yrk9J7gBej` (override with `-PayTo`). The pass is the check at the end showing `quotes 0.01 RLUSD for chat`, `quote network xrpl:1`, `pays to rn5h...`, and no FAIL for ca-paywall.
3. Restart the console (`node test-console\console\server.ts --models-file config\local-models.cpu.json`) and reload http://127.0.0.1:8730: the button reads "Send ($0.01)".

## 2026-10-24 — P2: TestNet RLUSD for a script buyer, without a browser wallet

No new environment variable. The seed is read from a file outside the repository with `--env-file` (example: `C:\PRIV-AI-SECRETS\testnet.env` holding `XRPL_SEED_B01_TESTNET=s...`, TestNet only). Owner steps, in `services/paywall`:
1. `npm test`: the pass is every test passing, including the 11 `buy-rlusd` tests.
2. New buyer wallet (if none): `node scripts\new-account.ts`; fund with the faucet API; `trust-line.ts` with the seed loaded for that one command.
3. Quote: `node scripts\buy-rlusd.ts --env-file C:/PRIV-AI-SECRETS/testnet.env --seed-prefix XRPL_SEED_B01 --amount 1 --max-xrp 5 --dry-run`.
4. Buy: the same command without `--dry-run`. The pass is `bought 1 RLUSD; transaction ...` and `RLUSD balance after: 1`.
- Balances (read-only, no seed): `node scripts\balances.ts --account buyer=racuvQQJSCD2YUxR5qLstLBfbCkxj53dcU --account seller=rn5hSy7QvsrQLpGb3k5dp4h8Yrk9J7gBej`, before and after a paid call.

## 2026-10-24 — R1: lenient restore and the end-to-end script

No new environment variable. New gateway flags (defaults on): `--restore-lenient on|off`, `--placeholder-instruction on|off`. The gateway source changed, so its image must be rebuilt. Owner steps:
1. Repo root: `npm test` (gateway); `services/paywall`: `npm test`. The pass is fail 0 in both.
2. `.\test-console\stack.ps1 -Rebuild gateway`, then `.\test-console\switch-models.ps1 -To ollama-cpu-8gb`; the start-up line shows `restore-lenient=on placeholder-instruction=on`.
3. In `services/paywall`: `node scripts\e2e-private-ask.ts --file ..\..\rig\tenants\t01\docs\supplier-dispute.txt --env-file C:/PRIV-AI-SECRETS/testnet.env --seed-prefix XRPL_SEED_B01`. The pass is `END-TO-END PASSED` (8 PASS lines), BEFORE/AFTER showing buyer -0.01 and seller +0.01 RLUSD. On Wi-Fi.
- Balances without typing addresses: `node scripts\balances.ts --title BEFORE --env-file C:/PRIV-AI-SECRETS/testnet.env --buyer-seed-prefix XRPL_SEED_B01 --seller-from-paywall http://127.0.0.1:8080`.
- stack.ps1 has no built-in pay-to address: pass -PayTo r..., or set XRPL_PAY_TO_TESTNET, or it keeps the running ca-paywall's.

## 2026-10-24 — H2 + X1 (owner, Windows PowerShell, from the repository folder)
1. `Remove-Item -Recurse -Force services\analyst\node_modules` (it holds Linux DuckDB files from the agent's test run; start-analyst.cmd reinstalls the Windows ones).
2. `npm test` (gateway, expect 327 pass) and `npm --prefix services\paywall test` and `npm --prefix services\analyst test` (after step 4 installs DuckDB; expect 32 pass).
3. `.\test-console\stack.ps1 -Rebuild gateway`, then `.\test-console\switch-models.ps1 -To ollama-cpu-8gb-hosted` (OpenRouter key at the hidden prompt; it is never written).
4. `test-console\start-analyst.cmd` (keep the window open).
5. `node test-console\console\server.ts --models-file config\local-models.cpu-hosted.json` -> http://127.0.0.1:8730, 02 Private chat: "Ask across files" with a data folder that holds 2+ CSV files.

## 2026-10-24 — ALL-1: one gateway with local + OpenRouter + Bedrock (owner, Windows PowerShell, repo folder)
Run the Docker stack from ONE clone only (this one): each clone's stack.ps1 / switch-models.ps1 replaces the same containers with its own gateway key.
1. `.\test-console\stack.ps1 -Rebuild gateway` and `.\test-console\stack.ps1 -Rebuild paywall`
2. `.\test-console\switch-models.ps1 -To ollama-cpu-8gb-all` - paste OPENROUTER_API_KEY, then BEDROCK_API_KEY, each with a RIGHT-CLICK at the hidden prompt.
3. Name a model to use it: local/qwen2.5-3b, hosted/nemotron-nano-reasoning, bedrock/nemotron-nano-3-30b (chainaim/auto stays local).
4. Console: `node test-console\console\server.ts --models-file config\local-models.cpu-all.json`

