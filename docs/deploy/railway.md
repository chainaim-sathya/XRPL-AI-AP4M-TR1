# Deploying on Railway

Three services in one Railway project, on its private network. Only the paywall is public. Fly.io works the same way (spec section 10).

| Service (exact name) | Root directory | Config file | Public | Variables |
|---|---|---|---|---|
| `presidio` | `services/presidio` | `services/presidio/railway.json` | no | `PORT=3000` |
| `gateway` | `/` | `services/gateway/railway.json` | no | `CHAINAIM_GATEWAY_KEY` (secret); `OPENROUTER_API_KEY` (secret, needed when chat launches) |
| `paywall` | `services/paywall` | `services/paywall/railway.json` | yes | `XRPL_PAY_TO_TESTNET` or `XRPL_PAY_TO_MAINNET`, `XRPL_NETWORK`, `RLUSD_ISSUER_MAINNET` (MainNet only), `GATEWAY_URL`, `PUBLIC_BASE_URL`, `CHAINAIM_GATEWAY_KEY` |

The service names matter: the gateway reaches `presidio.railway.internal:3000`, and the paywall reaches `gateway.railway.internal:8700`.

## 1. Before you start

- The repository is on GitHub (Railway builds from it, and the challenge asks for the link).
- A payTo account: an XRP Ledger address you control (`r...`), funded with the XRP reserve and holding a trust line to the RLUSD issuer (`node scripts/trust-line.ts` in `services/paywall` opens one on TestNet).
- A separate buyer account for test payments. `node scripts/new-account.ts` in `services/paywall` makes one with the family seed `pay.ts` reads. On TestNet, fund it with XRP (https://xrpl.org/resources/dev-tools/xrp-faucets), open its RLUSD trust line with `scripts/trust-line.ts`, and get RLUSD from https://tryrlusd.com/.
- A gateway key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`

## 2. Create the services

1. New project, then "Deploy from GitHub repo", then this repository and branch.
2. `presidio`: Settings, Source, Root Directory `services/presidio`; Config-as-code path `services/presidio/railway.json`; variable `PORT=3000`; memory 2 GB. No public domain.
3. `gateway`: Root Directory `/`; config path `services/gateway/railway.json`; add a Volume mounted at `/data` (the decision ledger); variable `CHAINAIM_GATEWAY_KEY` = your key. No public domain.
4. `paywall`: Root Directory `services/paywall`; config path `services/paywall/railway.json`; Networking, Generate Domain. Variables:
   - `XRPL_PAY_TO_TESTNET` = your payTo address
   - `XRPL_NETWORK` = `testnet` (switch to `mainnet` in step 5)
   - `FACILITATOR_URL_TESTNET` only to use a facilitator other than the default, `https://xrpl-facilitator-testnet.t54.ai`
   - `GATEWAY_URL` = `http://gateway.railway.internal:8700`
   - `PUBLIC_BASE_URL` = `https://<the generated domain>`
   - `CHAINAIM_GATEWAY_KEY` = `${{gateway.CHAINAIM_GATEWAY_KEY}}` (a reference to the gateway's value)

Every service uses the restart policy "always" (set in its `railway.json`). Expect about $10 to $25 a month, mostly Presidio's memory.

## 3. Check it

```bash
curl https://<domain>/healthz                     # {"status":"ok"} once Presidio is up
curl -si -X POST https://<domain>/v1/privacy/scan -H "content-type: application/json" -d '{"text":"hi"}' | grep -i payment-required
cd services/paywall && npm install && node scripts/pay.ts --dry-run https://<domain>/v1/privacy/scan '{"text":"hi"}'
```

The dry run prints the price (0.01 RLUSD unless `PRICE_SCAN` is set), the asset and its issuer, the network, your payTo and the invoice id. If the gateway can't start, its log names the missing Presidio entity, the entity types Presidio did not detect in its start-up test sentence, or the unreachable Presidio.

## 4. Pay on TestNet

```bash
cd services/paywall
read -rsp "Buyer's family seed: " XRPL_BUYER_SEED_TESTNET && export XRPL_BUYER_SEED_TESTNET && node scripts/pay.ts https://<domain>/v1/privacy/scan '{"text":"Patient Jane Roe, MRN 991122, was diagnosed with diabetes."}'
```

Expect `HTTP 200`, the scan result and a payment line with a transaction id. A correct scan result has `dataClass` `PHI`, and its `counts` include PERSON, MEDICAL_RECORD and HEALTH_TERM for this synthetic sentence; anything less means Presidio is not detecting as it should. The paywall's log shows one `payment_settled` line.

## 5. Switch to MainNet

1. Set `XRPL_NETWORK=mainnet`, `XRPL_PAY_TO_MAINNET` to the MainNet payTo account (with an RLUSD trust line), and `RLUSD_ISSUER_MAINNET` to the issuer address copied from Ripple's RLUSD documentation that day. The service redeploys.
2. Make one real payment per live route from the separate buyer account: scan and mask now, chat when it launches.
3. Bazaar discovery: the paywall still declares its discovery metadata on every price, but whether the t54 facilitator lists it is not confirmed (open question 4 in `architecture-xrpl-migration.md`).

## 6. Monitor

Create a free UptimeRobot HTTP monitor on `https://<domain>/healthz` every 5 minutes with email alerts. The paywall proxies it to the gateway, which checks Presidio, so it covers all three services. Add a second monitor on `GET https://<domain>/v1/models`: it is free and goes through the gateway key, so it catches a wrong `CHAINAIM_GATEWAY_KEY`, which `/healthz` (no key) cannot see.

## 7. When chat launches

The gateway image runs with `--model-source openrouter-free`. Until `OPENROUTER_API_KEY` is set on the gateway, chat reports no capacity and the paywall refuses chat calls without charging; scan and mask are unaffected. To launch chat: buy $10 of OpenRouter credits (1,000 free-model requests a day), add `OPENROUTER_API_KEY` to the gateway, redeploy it, and run `npm run verify:openrouter` from your PC with the same key (V1, V2 and V5). Then make one real MainNet payment on chat.
