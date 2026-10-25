# xrplh-8 — Strands Agents SDK vs Amazon Bedrock direct: analysis and implementation design

**Written:** 2026-10-24 11:30 IST (Sat 02:00 ET; hack starts Sat 09:00 ET = 18:30 IST). **Design only — no code changed.**
**Repo analysed:** `C:\SATHYA\CHAINAIM3003\mcp-servers\FINAGENTS\PRIVAI2\chainaim-router-private-ai-2`

**Tags**
- `[CODE file]` read in this repo today · `[DOC file]` design/state file read today · `[CHAT name]` past chat (snippets, not full transcripts)
- `[WEB-AWS]` AWS page/re:Post read today · `[WEB-2nd]` secondary source (not AWS) — confirm before relying on it
- `[ASSUME]` inference, not verified · `[CHECK]` must be verified; the step that verifies it is named

---

## 0. Bottom line

1. **"Strands vs Bedrock" is not either/or in your code.** Strands is the agent loop; Bedrock is the model it calls. Your buyer agent is **already** a Strands (TypeScript SDK 1.20.0) agent with `BedrockModel` `[CODE services/paywall/scripts/agent.ts, agent-core.ts]`. The real choices are:
   - **Agent loop (role A):** Strands (have it) vs a hand-written Bedrock Converse loop vs managed Bedrock Agents.
   - **ChainAim's answering model (role B, gateway):** Bedrock called directly (OpenAI-compatible endpoint) — Strands plays no part there.
2. **Fastest path to the goal = keep Strands + BedrockModel for role A**, close the one privacy gap (prompt masking, B3), and switch the model by flag if the Anthropic form is still pending. Role B (Bedrock in the gateway) is a stretch.
3. **Do not** port the agent to Python (as xplh-4's `hack/strands/*.py` layout suggested), **do not** rewrite it as a raw Converse loop, and **do not** use managed Bedrock Agents or AgentCore Runtime for the tenant agent: each costs hours and AgentCore/Bedrock Agents break the "books never leave the tenant machine" rule.
4. **The critical-path blocker is manual, not code:** AWS account verification + Anthropic use-case form, last seen blocking on 2026-10-23 20:15 IST `[DOC DESIGN/AWS-Bedrock-design-plan.md §3 B0]`. Status today is unknown.

---

## 1. Goal (as recorded in the chats)

- XRPL AI & Fintech hackathon (NYC, 36 h). AWS sponsor track wants **Strands agent loop + Bedrock inference + KMS** `[CHAT xplh-3 §9 Sponsors; xplh-4 judges table]`.
- Rule for AWS: **Bedrock sees masked text only** `[CHAT xplh-3 L4 Pattern B; DOC AWS-Bedrock-design-plan §1]`.
- Judges should see in the public submission repo: Strands loop, a thin Bedrock adapter on masked text, client masking before inference; the router/gateway/ACTUS Mentor stay private `[CHAT xplh-4]`.
- Only work done during the event counts; pre-built infra must be disclosed and used as pinned dependency `[CHAT xplh-4]`.
- Latency target ≤ 10 s p95 per on-stage action `[CHAT cont-2 citing X4-WORK §5]`.

---

## 2. What each chat decided — and whether it still holds

| # | Decision | Source | Verified today? |
|---|---|---|---|
| D1 | Strands buyer agent with one tool `private_ask(question, folder)` | xplh-3 B3/L4 | **Holds, refined:** code has `chainaim_private_ask(file, question)` — file name, not folder `[CODE agent-core.ts]` |
| D2 | Pattern A (local Ollama brain) default; Pattern B (Bedrock brain on masked text) for AWS | xplh-3 | **Code implements B only** (BedrockModel). Pattern B's precondition — mask on entry — is **not built** `[CODE agent-core.ts header; STATE.md last line]` |
| D3 | Strands supports Ollama (`strands-agents[ollama]`, `OllamaModel`) | xplh-3 | Verified then for the **Python** SDK. The code is the **TypeScript** SDK; TS has an `OpenAIModel` import path `[WEB-2nd awslabs nx-plugin guide]`, Ollama via OpenAI-compatible URL is `[CHECK]` |
| D4 | Bedrock models: Nemotron 3 Nano / Gemma 3 4B for masked text, us-east-1 | xplh-3, xplh-4 worklist | Model IDs **never verified** `[DOC AWS-Bedrock-design-plan §7]` |
| D5 | `hack/strands/` in **Python**: `agents/{jupiter,kestrel}.py, tools.py, bedrock.py, loop.py` | xplh-4 / restructure-1 tree | **Conflicts with code** (TypeScript, working, 90 tests). Recommend dropping the Python plan (§5) |
| D6 | Strands calls payment/mandates via MCP server `services/tools-mcp` (rig r13) | xplh-4 | `tools-mcp` **does not exist** in the repo `[CODE directory tree]` |
| D7 | Boundary: `hack/` → infra only via HTTP/MCP/schemas; never imports `services/*` | xplh-4 | **Current agent violates it:** imports `./client-mask.ts`, `./private-ask-core.ts`, `./xrpl.ts` from `services/paywall/scripts` `[CODE agent-core.ts imports]` |
| D8 | Carve-out: `client-privacy`, `schemas`, `attestation-verify` public; `xrpl-payer`, `signer` private | restructure-1 §5 | **Conflict:** a public agent that pays needs a payer. See decision Q2 (§10) |
| D9 | Gateway role B on Bedrock via OpenAI-compatible endpoint, catalog config, `probe:false` | AWS-Bedrock-design-plan B5 | Plausible; two unknowns: `provider` field and model coverage (§8) |
| D10 | Buyer prompt to Bedrock is unmasked — known gap | restructure-1, cont-2 §7 | **Confirmed in code** `[CODE agent-core.ts header comment]` |

---

## 3. What the code actually has (verified)

**Role A — agent brain** `[CODE services/paywall/scripts/agent.ts, agent-core.ts, package.json]`
- `@strands-agents/sdk` **1.20.0** and `zod` 4.6.7 are **devDependencies** of `services/paywall`.
- `new BedrockModel({ region, modelId, maxTokens })`; flags `--region` (us-east-1), `--model-id` (default `global.anthropic.claude-sonnet-4-6`), `--agent-max-tokens`, `--max-turns`, `--max-spend`, `--max-tokens`, `--dry-run`, `--show-masked`, `--no-names`.
- `new Agent({ model, tools:[askTool], systemPrompt, toolExecutor:"sequential", printer:false })`; `agent.invoke(prompt, { limits:{ turns } })`.
- Tool reads only files inside the tenant docs folder (realpath check), masks on the machine, pays RLUSD via x402, returns the **masked** answer; restored answer is printed locally only; session RLUSD ceiling.
- **What the model sees:** the typed prompt (unmasked), the **document file names** (in the system prompt), the tool's question, masked answers.
- Tests: 90/90 on the PC (2026-10-23 14:02 IST) — but that run was in `chainaim-router-XRP-RLUSD-`, not this repo `[DOC BUILD_LOG L1]`.
- **This repo has no `services/paywall/node_modules`** (search returned ENOENT today) → `npm install` needed here before anything runs.
- **No Bedrock call has ever succeeded from the agent.** Last seen: "account being verified" and "Anthropic use-case not submitted" `[DOC AWS-Bedrock-design-plan §3 B0]`.

**Role B — gateway answering model** `[CODE services/gateway/src/catalog.ts, dispatch.ts]`
- Catalog supports any OpenAI-compatible deployment: `baseUrl`, `servedModel`, `apiKeyEnv` (Bearer), `probe`, `zone: local|private-cloud|public-api`, `pricing`.
- `dispatch.ts` **always** adds `provider: { data_collection }` to the body (OpenRouter field) and POSTs `{baseUrl}/chat/completions`.
- Gateway masks everything before dispatch, residual guard, fails closed `[DOC PROJECT_CONTEXT.md; BUILD_LOG M1]`.
- PROJECT_CONTEXT constraint: **gateway has no npm runtime dependencies** → no AWS SDK / SigV4 library inside the gateway.

---

## 4. The options compared

- **S — Strands SDK + BedrockModel** (current code, role A)
- **D1 — Bedrock direct, hand-written Converse tool loop** (`@aws-sdk/client-bedrock-runtime`, role A)
- **D2 — Managed Bedrock Agents / AgentCore Runtime** (agent hosted on AWS, role A)
- **D3 — Bedrock direct in the gateway** (OpenAI-compatible `bedrock-runtime …/openai/v1`, role B)

| | **S: Strands + BedrockModel** | **D1: raw Converse loop** | **D2: managed agent on AWS** | **D3: gateway → Bedrock** |
|---|---|---|---|---|
| Status | Coded, 90 tests; never run against Bedrock | Not written | Not written | Not written; config mostly |
| Time to first demo | **Lowest**: manual AWS unblock + B3 (~2–3 h AI) | +4–6 h `[ASSUME]` (loop, tool-use parsing, turn limits, retries, tests) | +6–10 h `[ASSUME]` (IAM, container/Lambda, deploy) | 2–4 h after R5 `[ASSUME]` |
| AWS judging fit | **Direct hit**: "Strands agent loop" + Bedrock | Bedrock yes, Strands no → weaker on AWS rubric | Strong AWS story | Bedrock inference shown, no agent |
| Model switching | `--model-id` flag only | Own code | Console/IaC | Catalog file |
| Privacy fit | Tool runs **on tenant PC** ✓; prompt gap needs B3 | Same as S | ✗ Tool would run in AWS → raw books must reach AWS, or a callback to the tenant PC must be built | ✓ Gateway already masks |
| Code changes | ~3 files (§7) | ~5 new + tests | new service + infra | 1–3 files + catalog/mode |
| Lock-in | Low (provider is one line; Strands also has OpenAI model) | None | High | Low |
| Main risk | AWS account/form; global profile data residency | Time | Time + breaks privacy rule | Endpoint model coverage, `provider` field |

### Advantages / disadvantages in short
- **S** + already built, tested, flag-driven; idiomatic TS; Strands handles tool-calling, turn limits, sequential execution; − TS SDK is young (1.20.0 pinned — good), adds `@aws-sdk` transitively, behaviour of BedrockModel on non-Anthropic models (Nova, Gemma) for tool calls is `[CHECK R5]`.
- **D1** + full control, no framework; − re-implements what Strands gives; loses the "Strands" judging point; no time benefit.
- **D2** + hosted, scalable, observability; − violates "books never leave"; IAM/deploy work; not achievable safely before demo.
- **D3** + makes AWS the only outside party for ChainAim answers; masked by construction; − ARCH-002 freezes the gateway (needs an ARCH-ID); OpenAI-compatible endpoint model list not confirmed for Claude/Nova `[CHECK R5 --openai-check]`; Bearer API key is the only auth the gateway can do without a SigV4 dependency.

---

## 5. Recommended architecture

**S for role A (keep TypeScript), D3 for role B as stretch.** No Python port, no D1, no D2.

```
Tenant PC (Jupiter)                                              AWS (us-east-1)
 agent.ts (Strands TS 1.20.0)
   1 maskPrompt(prompt) ── masked prompt + doc aliases ─────────► Bedrock Converse (BedrockModel)
   2 tool chainaim_private_ask(file, question)                    role A brain: sees masked text only
        read doc (docs folder only) → mask locally → leak gate
        → x402 pay RLUSD (tenant wallet, --max-spend) ──┐
   3 restore placeholders → screen only                  │
                                                         ▼
                       Paywall (x402 verify/settle via t54, Testnet)
                         → Gateway: Presidio rescan → mask → residual guard
                             → catalog model: local Ollama | OpenRouter | (stretch) Bedrock OpenAI-compatible (role B)
```

Why this is fastest: every box except `maskPrompt` already exists and has tests; the remaining blockers are an AWS account form and a model choice — both flag/console work.

---

## 6. Costs

**Strands SDK:** no licence cost (open source) `[ASSUME — licence not re-read today]`. **Bedrock:** pay per token, billed to the AWS account (free-plan credits $100 noted 2026-10-23 `[DOC AWS-Bedrock-design-plan B7]`).

Prices per 1M tokens, input/output — **secondary sources, confirm on aws.amazon.com/bedrock/pricing before quoting**:
- Claude Sonnet 4.6 (global): $3.00 / $15.00 `[WEB-2nd]`
- Amazon Nova 2 Lite (global): $0.30 / $2.50 `[WEB-2nd]`
- Gemma 3 4B: $0.04 / $0.08 `[WEB-2nd]`

Per agent request estimate `[ASSUME: 3 model turns × ~1,500 input tokens (system prompt + tool schema + history) and ~300 output tokens per turn]`:
- Sonnet 4.6 ≈ 4,500 × $3/M + 900 × $15/M ≈ **$0.027**
- Nova 2 Lite ≈ **$0.0036**
- 300 demo/rehearsal requests: Sonnet ≈ $8, Nova 2 Lite ≈ $1.1.

Note: with Sonnet, the tenant's agent-brain cost (~$0.027) is larger than ChainAim's price per answer (0.01 RLUSD). Fine for the demo; matters for the pitch's unit economics. R5 measures real token counts.

---

## 7. Privacy

**Bedrock platform** `[WEB-AWS re:Post knowledge-center/amazon-bedrock-model-data-use]`: Bedrock does not store input/output, does not share it with model providers, does not train on it; models run in per-provider deployment accounts the providers cannot access; automated abuse detection, no human access. **Caveat:** if *model invocation logging* is switched on in the account, prompts are logged to your S3/CloudWatch `[WEB-2nd]` — keep it off or treat logs as sensitive.

**Gaps in the current agent (verified in code):**
1. **Typed prompt reaches Bedrock unmasked** `[CODE agent-core.ts header]` → B3 below.
2. **Document file names reach Bedrock** (listed in the system prompt) `[CODE agent-core.ts systemPrompt]` — a name like `john-smith-discharge.txt` leaks. → B3b aliases (`doc-1.txt`).
3. **Default model id is a `global.` inference profile**, which may process in other regions `[ASSUME — AWS doc on cross-region inference not read today; CHECK]`. If a tenant's policy requires a region (xrplh-7 policy table has `region`), use a `us.` profile or an in-region model id — flag-only change.
4. Masked ≠ anonymous: company names, amounts, diagnoses stay `[CHAT restructure-1 Limit 2]`.

---

## 8. Blockers and checks (each with its resolving step)

| # | Blocker / unknown | Kind | Resolved by |
|---|---|---|---|
| K1 | AWS account verification + Anthropic use-case form | Manual | Step M1 |
| K2 | No `node_modules` in this repo's `services/paywall` | Manual | Step M2 |
| K3 | Tool-calling quality of non-Claude models (Nova 2 Lite, Gemma 3 4B) via BedrockModel | Check | A1 (R5 rig) |
| K4 | Exact model ids (Nova 2 Lite seen as `global.amazon.nova-2-lite-v1:0` in the AgentCore TS SDK README `[WEB-2nd]`; Nemotron/Gemma unknown) | Check | M3 console model catalog + A1 |
| K5 | `aws login` sessions last 12 h `[DOC AWS-Bedrock-design-plan §8]` — will expire during the 36 h event | Manual | Re-login before each demo block |
| K6 | Sophos firewall on wired LAN blocks t54 → paid runs need Wi-Fi `[DOC STATE.md]` | Env | Run paid steps on Wi-Fi |
| K7 | Boundary: agent imports `services/paywall/scripts/*` (D7) | Design | Decision Q2 + A4 |
| K8 | Role B: does bedrock-runtime's OpenAI-compatible endpoint serve the chosen models, and does it reject `provider`? | Check | A1 `--openai-check` |
| K9 | Gateway frozen by ARCH-002 → role B code needs an ARCH-ID | Decision | Q3 |
| K10 | Event rule: agent code exists before the event → README must list it as pre-existing | Process | A4 README |

---

## 9. Step-by-step implementation plan

Order is chosen for speed: unblock AWS first, prove one masked agent call, then carve into the submission repo, then stretch.

### Phase 0 — before 09:00 ET (verification only, allowed pre-event)

**M1 (Manual) AWS readiness.** Bedrock console, us-east-1: account verified? Anthropic use-case form submitted? If the form is pending, continue with Nova 2 Lite (no Anthropic form) `[ASSUME: Amazon models need no use-case form — CHECK in console]`.
- Done when: the console's model catalog shows the model as usable.

**M2 (Manual) Install and test this repo.** `cd services\paywall; npm install; npm test` in `chainaim-router-private-ai-2`.
- Done when: all paywall tests pass (90 at last count; the number may differ in this repo — report it).

**M3 (Manual) First Bedrock dry run** (no payment; Bedrock is called):
```
$env:AWS_PROFILE="chainaim"; aws login
node scripts/agent.ts --tenant t02 --dry-run --model-id <id from M1> --prompt "What does my discharge note say about follow-up?"
```
- Done when: the agent calls `chainaim_private_ask`, prints `dry_run`, and answers. Record latency.

**A1 (AI) Rig R5 `services/paywall/scripts/rigs/bedrock.ts`** — as designed in AWS-Bedrock-design-plan B2.
- Flags: `--region us-east-1` · `--model-id` (repeatable) · `--tool-check on|off` (on) · `--openai-check on|off` (off) · `--api-key-env BEDROCK_API_KEY` · `--timeout-ms 30000` · `--out rig/out/rigs.jsonl`.
- Uses `@aws-sdk/client-bedrock-runtime` Converse (present transitively via Strands `[CHECK version after M2]`).
- Tests: injected client — pass, no tool call, access denied, timeout. No real AWS in `npm test`.
- Done when: one JSONL line per model: `pass, toolCall, openaiCompatible, latencyMs, inputTokens, outputTokens`.

**A2 (AI) B3 — mask the agent's input before Bedrock.**
- `agent-core.ts`: `AskSession.maskPrompt(prompt)` → `maskText` + detect self-check (refuse if anything identifiable remains); store the map in `maps` so `restoreForDisplay` restores it.
- `agent-core.ts`: B3b `docAliases` — system prompt lists `doc-1.txt …`; the tool resolves alias → real file locally.
- `agent.ts`: call `maskPrompt` before `agent.invoke`; print masked prompt under `--show-masked`.
- New flags: `--prompt-mask on|off` (default **on**) · `--doc-aliases on|off` (default **on**) · `--model-provider bedrock|openai-compatible` (default bedrock; `openai-compatible` + `--model-base-url http://127.0.0.1:11434/v1` is the Pattern A fallback, **only if** the TS SDK's OpenAI model works with Ollama `[CHECK in A1]`).
- Tests (stub model records its inputs): name/e-mail/Aadhaar in the prompt reach the model only as placeholders; real file names never reach the model; restored reply shows real values; `off` reproduces today's behaviour; all existing tests still pass.
- Files: `agent-core.ts`, `agent.ts`, `test/agent.test.ts` (3 files).
- Done when: tests green and `--show-masked` shows the masked prompt.

**M4 (Manual) Choose the agent model** from A1 + M3: tool-call PASS and p95 latency within budget; prefer the cheapest passing model, keep Sonnet as `--model-id` fallback.

**M5 (Manual) Paid run on Wi-Fi:**
`node scripts/agent.ts --tenant t02 --url http://127.0.0.1:8080 --model-id <chosen> --show-masked --prompt "..."`
- Done when: `answered, 0.01 RLUSD, tx …` and one `payment_settled` line in `docker logs ca-paywall`. This is the AWS-track proof: Strands loop + Bedrock on masked text + RLUSD settlement.

### Phase 1 — during the event (submission repo)

**A3 (AI, after Q2) Make the agent liftable.** Move the masking functions the agent uses into `packages/client-privacy` (shim left at `scripts/client-mask.ts`, as restructure-1 planned) and the payer into `packages/xrpl-payer` (or call a local `tools-mcp` — see Q2). The agent then imports package names only.

**A4 (AI) Submission `hack/strands/` in TypeScript:** `jupiter-agent.ts` (from agent.ts), `agent-core.ts`, a `kestrel-agent.ts` only if channel B needs an agent (its credit-check is an HTTP call `POST /v1/disclose/credit-check` per xplh-4 S2, so a second agent is optional). README: pre-existing vs built at the event; model ids; how masking precedes inference.

**A5 (AI, optional) Strands → MCP tool** (r13) only if `tools-mcp` is built for mandates/limits; otherwise skip — the in-process tool already enforces `--max-spend`.

### Phase 2 — stretch

**A6 (AI + manual, after Q3) Role B on Bedrock** — AWS-Bedrock-design-plan B5: `config/catalog.bedrock.json` (`zone:"private-cloud"`, `probe:false`, `apiKeyEnv:"BEDROCK_API_KEY"`), `test-console/modes/bedrock.json`; code only if A1 shows it is needed: per-deployment `policyField: "openrouter"|"none"` in `catalog.ts` + `dispatch.ts`, Bedrock 403 → `model_restricted` in `openrouter.ts` `categorize`. Manual: create a Bedrock API key (shortest expiry), enter it at the `switch-models.ps1` hidden prompt.

**Not planned:** AgentCore Runtime / Bedrock Agents for the tenant agent (breaks local-books rule); Python port.

### File change count (recommended path)
| Phase | New | Modified |
|---|---|---|
| A1 rig | 2 (`rigs/bedrock.ts`, `test/rig-bedrock.test.ts`) | 0 |
| A2 masking | 0 | 3 (`agent-core.ts`, `agent.ts`, `test/agent.test.ts`) |
| A3 packages | 2 packages (~4 files) | 3 shims |
| A4 submission | ~3 + README | 0 (new repo) |
| A6 stretch | 2 config | 0–3 (`catalog.ts`, `dispatch.ts`, `openrouter.ts`) + tests |

---

## 10. Decisions needed from you

- **Q1 Agent model for the demo:** Sonnet 4.6 (best tool-calling, ~7× cost, needs Anthropic form) vs Nova 2 Lite (cheap, no form, tool-calling `[CHECK A1]`). Recommendation: decide after A1; default to whichever passes and is cheaper.
- **Q2 Payer in the public repo:** (a) publish `xrpl-payer` as open (it wraps public `x402-xrpl`/`xrpl` libraries — little IP) — **fastest**; (b) keep it private and have the public agent call a locally run `tools-mcp` — +3–5 h `[ASSUME]`. Recommendation: (a).
- **Q3 ARCH-ID for gateway changes (role B)** — only needed for A6.

---

## 11. Sources

- Code: `services/paywall/scripts/agent.ts`, `agent-core.ts`, `services/paywall/package.json`, `services/gateway/src/dispatch.ts`, `catalog.ts`.
- Docs: `PROJECT_CONTEXT.md`, `STATE.md`, `BUILD_LOG.md` (tail), `DESIGN/AWS-Bedrock-design-plan.md`.
- Chats: xplh-3 (8db26b31…), xplh-4 (cd764f1f…), Chainaim-router-restructure-1 (96a57903…), Restructure-sathya-cont-2 (56dd831c…) — searched snippets, not full transcripts.
- Web: AWS re:Post "Does Amazon Bedrock share input and output data with model providers…" ; strandsagents.com TypeScript deploy-to-AgentCore guide; awslabs nx-plugin TS Strands guide; bedrock-agentcore-sdk-typescript README (mirror); pricing aggregators (secondary).

---

## 12. Update 2026-10-24 13:20 IST — what the runs changed in this plan

**Superseded by evidence `[RUN, BUILD_LOG 2026-10-24]`:**
- Region is **ap-southeast-2**, not us-east-1: the free-plan project cannot use other regions without a plan upgrade.
- Agent model is **`nvidia.nemotron-nano-3-30b`** (serverless; Converse tool call checked; no Anthropic form). Claude Sonnet 4.6 / Nova 2 Lite were not needed. K1 (account/form) and K2 (node_modules) are closed.
- Steps M1–M5 done: dry run and paid run passed (tx `1381D3AC…8660`). A2 (prompt masking + doc aliases) is coded; `--tenant-label` added; defaults switched to Sydney + Nemotron. Test run on the PC pending.

**Found during the runs:** the gateway's residual check refused the masked discharge note (titled_name across a line break) — fixed in `privacy/residual.ts`; the agent's model invented a refusal reason — the tool now passes ChainAim's reason.

**Answer-model decision (analysis 13:00, chats xplh-3/xplh-4/cont-2 + code):**
- xplh-3 assigned "write the actual answer" to ChainAim's chosen model on masked text, remote (Bedrock or OpenRouter), and named Nemotron 3 Nano on Bedrock for masked text; xplh-4 wants Bedrock inference on masked text shown to judges; in cont-2 the owner accepted hosted answering models.
- Local Qwen answered today only because the gateway's loaded catalog (`ollama-cpu-8gb`) has local models only; CPU Qwen (~8–18 s) does not fit the ≤10 s on-stage budget.
- **Recommended:** Nemotron for both roles — agent brain (Strands `BedrockModel`) and ChainAim's answering model through the gateway's router — with local Qwen kept in the same catalog as the local-only/fallback route. Today's Nemotron + local Qwen setup stays as the verified fallback until the gateway→Bedrock rig passes.
- Privacy note: the masked answer already returns to Nemotron as the tool result (`ToolReply`), so AWS sees it in both options; the extra exposure of option B is the masked document itself.

**Next:** Bedrock API key (manual) → rig `--openai-check` → `config/catalog.bedrock.json` + `test-console/modes/bedrock.json` (→ `policyField` only if needed) → PHI/private-cloud decision → invocation logging off → pass-through option → end-to-end timing.
