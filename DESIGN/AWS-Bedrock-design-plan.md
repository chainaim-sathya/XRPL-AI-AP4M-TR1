# AWS Bedrock in chainaim-router-XRP-RLUSD-: design plan

**Written:** 2026-10-23 20:15 IST. Design only; no code was changed.
**Belongs to:** plan v3 layer **L4 (AWS)**, rig **R5**; iterations I1, I3 and I6 in `2026-10-23T1603+0530_codebase-review-and-iteration-plan.md`.

**Tags**
- `[CODE]`: read in the repo today.
- `[AWS-DOC]`: read today on docs.aws.amazon.com (links in §9).
- `[RUN]`: seen in your PowerShell output today.
- `[CHECK]`: not verified yet; the step that verifies it is named.

---

## 1. What Bedrock does in ChainAim: two roles, one rule

| Role | Who calls Bedrock | API | Credentials | Status |
|---|---|---|---|---|
| **A. Agent brain** | Each tenant's Strands buyer agent (`scripts/agent.ts`) | Bedrock runtime through the Strands SDK's `BedrockModel` [CODE] | Your `aws login` session, profile `chainaim` (`AWS_PROFILE`) [RUN] | Coded. Dry run blocked by account setup (§3). |
| **B. ChainAim's answering model** | The gateway (`services/gateway`), after it masks the request | OpenAI-compatible Chat Completions on `bedrock-runtime` [AWS-DOC] | A Bedrock API key sent as `Authorization: Bearer` [AWS-DOC], read from an environment variable named in the catalog [CODE] | Not built. Mostly configuration (§5). |

**The rule (plan v3, L4):** Bedrock sees **masked text only**, in both roles.
- **Role B:** already guaranteed. The gateway masks before dispatch [CODE `chat.ts`].
- **Role A:** **not guaranteed today.** The typed prompt reaches Bedrock as written [CODE `agent-core.ts` comment; RUN]. Step B3 fixes this.

```
Tenant PC                                           AWS us-east-1
  agent.ts ──(masked prompt, B3)──────────────────► Bedrock runtime (role A: Claude Sonnet 4.6 or other)
     └ tool chainaim_private_ask: read docs → mask → pay RLUSD
                    │ masked body + x402 payment
                    ▼
  Paywall ─► Gateway: Presidio → classify → mask ──► bedrock-runtime /openai/v1/chat/completions (role B)
                                                 └─► other catalog models (local Qwen, …)
```

---

## 2. What the code already provides (no change needed)

- **Role A:**
  - `agent.ts` builds `new BedrockModel({ region, modelId, maxTokens })`.
  - Flags: `--region` (default `us-east-1`), `--model-id` (default `global.anthropic.claude-sonnet-4-6`), `--agent-max-tokens`, `--max-turns`.
  - Credentials come from the AWS SDK chain; none are read in code [CODE].
  - Shown working with `aws login`: the run on 2026-10-23 reached Bedrock with `AWS_PROFILE=chainaim` [RUN].
- **Role B:**
  - The gateway's `catalog` mode calls any OpenAI-compatible deployment: `POST {baseUrl}/chat/completions` with `Bearer` read from `apiKeyEnv`.
  - `probe: false` turns off health probes.
  - Each model has a `zone` (`local | private-cloud | public-api`) and `pricing` per 1M tokens [CODE `catalog.ts`, `dispatch.ts`, `pool.ts`].

---

## 3. Step-by-step plan

Each step lists: objective · AI vs manual · files · flags · tests · done when.

### Step B0: AWS account readiness (manual)
- **Objective:** Bedrock accepts calls from this account.
- **Found today:**
  1. "Your account is currently being verified" [RUN].
  2. "Model use case details have not been submitted": the Anthropic use-case form [RUN].
- **Manual:**
  - Wait for verification (AWS says normally under 2 hours; otherwise email `aws-verification@amazon.com`).
  - Submit the Anthropic use-case form in the Bedrock console, then wait 15 minutes.
  - Region: us-east-1.
- **Done when:** the B1 dry run finishes without an account or form error.

### Step B1: Finish the agent runs (manual; code exists)
- **Dry run:**
  ```
  $env:AWS_PROFILE="chainaim"
  node scripts/agent.ts --tenant t02 --dry-run --prompt "What does my discharge note say about follow-up?"
  ```
- **Paid run:** the same command with `--url http://127.0.0.1:8080` instead of `--dry-run`, on Wi-Fi (the wired LAN's Sophos firewall blocks t54).
- **Done when:**
  - **Dry run:** a reply about the 2-week diabetes review and the 3-month HbA1c test.
  - **Paid run:** `answered, 0.01 RLUSD, tx …` plus one `payment_settled` line in `docker logs ca-paywall`.

### Step B2: Rig R5, the Bedrock check script (AI)
- **Objective:** PASS/FAIL per model before we build on it, as plan v3 requires.
- **New file `services/paywall/scripts/rigs/bedrock.ts`**, using the AWS SDK Bedrock Runtime client (`@aws-sdk/client-bedrock-runtime`, already present through Strands; [CHECK] the version).
- **What it does, for each `--model-id`:**
  1. One short Converse call: record latency and input/output tokens.
  2. With `--tool-check on`: one call with a dummy tool; PASS only if the model returns a tool call. The agent needs tool calling.
  3. With `--openai-check on`: the same prompt through `https://bedrock-runtime.{region}.amazonaws.com/openai/v1/chat/completions` with `BEDROCK_API_KEY`. This tells us whether the model can serve role B.
- **Flags:**
  - `--region us-east-1`
  - `--model-id` (repeatable)
  - `--tool-check on|off` (default on)
  - `--openai-check on|off` (default off)
  - `--api-key-env BEDROCK_API_KEY`
  - `--timeout-ms 30000`
  - `--out rig/out/rigs.jsonl`
- **Models to test** (IDs to confirm on each model card; [CHECK]):
  - Claude Sonnet 4.6 (`global.anthropic.claude-sonnet-4-6`, the agent default) [CODE]
  - `openai.gpt-oss-120b-1:0`, the model in AWS's OpenAI-compatible examples [AWS-DOC]
  - Nemotron 3 Nano and Gemma 3 4B, the cheap models priced in xplh-3; their exact IDs are not verified today
- **Tests:** unit tests with an injected client (pass, no tool call, access denied, timeout). No real AWS in `npm test`.
- **Done when:** `rig/out/rigs.jsonl` has a line per model with `pass`, `toolCall`, `openaiCompatible`, `latencyMs` and tokens.

### Step B3: Mask the agent's prompt before Bedrock (AI)
- **Objective:** close the role A gap, so the agent's model sees masked text only.
- **Files:**
  - `scripts/agent-core.ts`: a new `AskSession.maskPrompt(prompt)` that runs `maskText`, then a `detect` self-check (refuse if anything remains), and keeps the map in the session's `maps`.
  - `scripts/agent.ts`: masks before `agent.invoke`. `restoreForDisplay` already merges session maps [CODE].
- **Flag:** `--prompt-mask on|off` (default `on`).
- **Tests:**
  - With a stub model: a prompt holding a name, e-mail or Aadhaar reaches the model only as placeholders.
  - The restored reply shows the real values.
  - `off` keeps today's behaviour.
- **Done when:** `--show-masked` prints the masked prompt, and the new tests plus all 90 existing ones pass.
- **Note:** organisation names such as "Riverside Clinic" are not detected by `client-mask.ts` [RUN]. Fixing that is pipeline work (I3), not Bedrock work.

### Step B4: Choose the agent's model (decision + config)
- **Objective:** pick the agent's model from R5 results and cost.
- **Options:**
  - Keep Claude Sonnet 4.6 (needs the B0 form; higher cost).
  - Switch the default to a cheaper model that passes the **tool check** in R5.
- **Change:** only the default of `--model-id` in `agent.ts`. No other code change.
- **Done when:** the chosen model passes R5 (tool check) and B1.

### Step B5: Bedrock as ChainAim's answering model, role B (AI + manual)
- **Objective:** the gateway sends masked chat to a Bedrock model, so AWS is the only outside party for answers (design T37).
- **Config (no code):**
  - New `config/catalog.bedrock.json`, with one model entry per chosen model:
    - `zone: "private-cloud"`
    - `capabilities` from the model card
    - `pricing` from the AWS Bedrock pricing page
    - a deployment with `"adapter":"openai"`, `"baseUrl":"https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1"`, `"servedModel":"<model id>"`, `"apiKeyEnv":"BEDROCK_API_KEY"`, `"probe": false`
  - Why `probe: false`: bedrock-runtime does not implement `GET /models` [AWS-DOC]. The pool's default health probe calls `{baseUrl}/models` [CODE `pool.ts`].
  - New mode `test-console/modes/bedrock.json`: `modelSource catalog`, catalog `config/catalog.bedrock.json`, `secretEnv ["BEDROCK_API_KEY"]`. `switch-models.ps1` then asks for the key hidden and never writes it to a file [CODE].
- **Possible code change** (only if R5 `--openai-check` shows it is needed):
  - `dispatch.ts` adds `provider: { data_collection }` to every request body [CODE]. That is an OpenRouter field.
  - If Bedrock rejects unknown fields (not stated in the docs; [CHECK] in R5), add a per-deployment catalog option `policyField: "openrouter" | "none"` (default `openrouter`, keeping today's behaviour). Bedrock deployments then omit it.
  - `categorize()` reads OpenRouter's error format [CODE `openrouter.ts`]. Map Bedrock's 403 "access denied / model not enabled" to `model_restricted` (skip that model), not `key_rejected` (which stops the chain).
  - Needs an ARCH-ID, because ARCH-002 freezes the gateway.
- **Manual:**
  - Create a Bedrock API key in the console (**API keys** in the Bedrock menu, visible in your screenshot).
  - [CHECK] short-term vs long-term key and its expiry; prefer the shortest that suits the demo.
  - Keep the key in your password manager and enter it only at the `switch-models.ps1` prompt.
- **Network:** the gateway container needs outbound HTTPS to `bedrock-runtime.us-east-1.amazonaws.com`. When Presidio is isolated (I8), isolate **Presidio only**, not the gateway.
- **Tests:**
  - The catalog validates.
  - A stub OpenAI-compatible server checks the gateway's body: masked messages, `servedModel`, no `provider` field when `policyField:"none"`.
  - A 403 maps to `model_restricted`.
- **Done when:** `switch-models.ps1 -To bedrock` answers its test question, and the decision ledger records `served: <bedrock model id>`.

### Step B6: Health data (PHI) on Bedrock
- **Objective:** decide whether PHI may go to Bedrock.
- **Today:** PHI is only allowed to providers that don't collect data; for the catalog that is tracked by the deny cache [CODE `select.ts`, `chat.ts`].
- **Decision:**
  - Treat `zone: "private-cloud"` (Bedrock) as no-collection **only after** reading AWS's Bedrock data-privacy statement. I did not read it today: [CHECK].
  - Until then, PHI requests keep today's behaviour.
- **Done when:** the policy is written into the catalog notes and covered by a test.

### Step B7: Cost for the control room (plan L3 panel 2)
- **Objective:** show "where masked data went" with an estimated provider cost and margin.
- **Data:** the catalog `pricing` × the completion's `usage` tokens, logged per request in the decision ledger. The ledger never holds text [CODE].
- **Note:** Bedrock is billed to the AWS account (free-plan credits: $100, 183 days left), not paid on XRPL. Show it as an estimate.
- **Done when:** the ledger lines for Bedrock calls carry the estimated cost.

### Step B8 (optional): Bedrock Guardrails
- **Option:** a guardrail on role B calls as a second filter.
- **Mechanism:** passed through `extra_body` / headers on the OpenAI-compatible API [AWS-DOC: mantle page; [CHECK] for bedrock-runtime].
- **Status:** stretch only; the gateway's own masking is the main control.

---

## 4. Order
B0 → B1 → B2 → B3 → B4 → B5 → B6 → B7 (→ B8 optional).
**Must-have for the demo:** B0–B4 (the agent on Bedrock, masked). **Strong entry:** add B5–B7.

## 5. Manual steps (yours), in order
1. Wait for account verification; submit the Anthropic form (B0).
2. Run the dry run and the paid run (B1).
3. Create a Bedrock API key (B5).
4. Choose the agent's model and the gateway models after R5 (B4/B5).
5. Approve the ARCH-IDs for B3 and B5.

## 6. AI steps (mine, after your go-ahead to change code)
B2 rig script · B3 prompt masking · B5 catalog, mode file and (if needed) the `policyField` / error mapping · B7 cost fields · tests and BUILD_LOG/STATE entries for each.

## 7. Unverified, with the step that checks it
- Tool-call support per model → B2.
- Whether bedrock-runtime rejects the `provider` field → B2 `--openai-check`.
- Exact model IDs for Nemotron 3 Nano and Gemma 3 4B → model cards / B2.
- The `@aws-sdk/client-bedrock-runtime` version bundled with Strands 1.20.0 → B2.
- Bedrock API key types and expiry → B5.
- AWS's Bedrock data-use statement → B6.
- Bedrock's error format for disabled models → B5.

## 8. Sources
- [Inference using Chat Completions API (bedrock-runtime)](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html): base URL `https://bedrock-runtime.{region}.amazonaws.com/openai/v1`; SigV4 or Bedrock API key; no `GET /models`.
- [Chat Completions on bedrock-mantle](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions-mantle.html): `https://bedrock-mantle.{region}.api.aws/v1`; Models API only there; guardrails through `extra_body`.
- [AWS CLI console-credential login](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html) and the [SDK login credentials provider](https://docs.aws.amazon.com/sdkref/latest/guide/feature-login-credentials.html): `aws login`, JS SDK v3 supported, 12-hour sessions.
