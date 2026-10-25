# PROJECT_CONTEXT: ChainAim privacy gateway

**What it is.** Paid privacy services for AI agents on the XRP Ledger (x402, RLUSD through the t54 facilitator): scan, mask and an OpenAI-compatible private chat that masks the conversation, routes it with Jev across OpenRouter's free models under a data policy, and restores the answer.

**Status (2026-10).** The payment rail moved from Algorand/USDC to XRPL/RLUSD on 2026-10-13 (`architecture-xrpl-migration.md`; the privacy pipeline is unchanged). First built for the Global x402 Challenge (Composite entry): scan and mask, the paywall, and private chat, with tests over stubs. Deployment follows `docs/deploy/railway.md`. Design: `docs/superpowers/specs/2026-09-24-privacy-gateway-design.md`. Plan: `docs/superpowers/plans/2026-09-25-privacy-gateway.md`.

## Components
| Name | Path | Role |
| --- | --- | --- |
| chainaim-paywall | services/paywall | Public: x402 payment, Bazaar metadata, chat capacity guard, proxy that strips payment headers, payment log |
| chainaim-gateway | services/gateway | Private: Presidio client, masking and restore, chat pipeline, free-pool routing, quota, decision ledger |
| Presidio analyzer | services/presidio | Private: entity detection (derived image enabling the Indian recognizers) |
| @chainaim/route-engine | packages/route-engine | The rules classifier used when Jev is off or the request is PHI (fork of BlockRunAI/router-core, MIT) |
| scoring table | config/free-models.json | Quality, tasks, speed and domains per free model |
| decision ledger | data/ledger/ (gitignored; /data/ledger on Railway) | One line per request; never text, placeholders or the map |

## Constraints
- The gateway has no npm runtime dependencies (Node built-ins; Node runs the TypeScript). The paywall uses Hono and the official x402 libraries.
- Secrets never go in config or git: environment variable NAMES only (`.env.example`).
- Presidio unreachable means scan, mask and chat answer 503 and `/healthz` reports 503 (the model list, capacity and deployment routes don't depend on Presidio): message text, tool-call arguments included, that has not been scanned is never sent anywhere.
- Everything that reaches a model is masked: message text, tool-call arguments, and the `tools`, `response_format` and `stop` fields (`privacy/mask.ts` `mapRequestFields`; `openrouter.ts` `shapeBody` never copies those three from the request). Tool and json_schema names must reach the model exactly, so a name holding personal data is refused (400).
- Extra personal data is detected and masked by default (`--extra-entities`, `privacy/entities.ts`): bank account numbers, titled names (MR/MRS/DR…), street addresses, dates of birth, and locations. The start-up test sentence covers each group switched on.
- Residual check (`privacy/residual.ts`, `--residual-guard on`): after masking, text that still holds a long digit run, spaced digit groups, an international phone number, an e-mail or a titled name is refused (422) before any model or Jev call; the refusal and the ledger hold kinds and counts only. `/v1/privacy/mask` reports the same as `residual`.
- Health data (PHI) goes only to providers that don't collect data (`provider.data_collection: deny`), and never to Jev.

## Run and test
See README.md. `npm test`, `npm run test:paywall`, `npm run test:engine`.

## Sources of truth
- x402 on the XRP Ledger: `@x402/*` 2.27.0 (core, hono, extensions, xrpl) on the paywall, `x402-xrpl` 0.3.3 for the paying scripts, t54 facilitator (`https://xrpl-x402.t54.ai/`)
- OpenRouter: models, key, chat and Decisions API references
- Presidio: `presidio-analyzer` 2.2.362
- Decisions: docs/adr/
