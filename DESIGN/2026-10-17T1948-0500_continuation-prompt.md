# Continuation prompt for the next session (2026-10-17, 19:48 UTC-05:00)

Paste the block below as the first message of a new chat.

```
Project: ChainAim privacy gateway (chainaim-router)
Root: C:\SATHYA\CHAINAIM3003\mcp-servers\FINAGENTS\PRIVAI1\chainaim-router
Read first: PROJECT_CONTEXT.md, then DESIGN\2026-10-17T1948-0500_local-gpu-models-session.md (all decisions D1-D13, the facts and the open items).

What we were doing:
Running the test-console UI (http://127.0.0.1:8730) against local Ollama models on my RTX 3070 Ti (8 GB) through the gateway in Docker, with every model setting in one file. The end goal is reconciling CSV exports (ERP, practice management, bank, income sheet, tax return).

Current state (working):
- Docker containers: ca-presidio, ca-gateway, ca-paywall, ca-openrouter-stub (network chainaim-test). Ollama runs on the host on the GPU (ASUS GPU Mode Ultimate).
- config\local-models.json is the only model config. scripts\local-models.ts generates config\generated\ (catalog, scores, summary, Modelfiles) and creates Ollama variants chainaim-<model>-ctx<N>.
- Models: local/deepseek-r1-1.5b (ctx 32768), local/qwen2.5-3b (ctx 32768), local/deepseek-r1-8b (ctx 12288, the DEFAULT). maxOutputTokens is 8192 for all.
- test-console\use-ollama.cmd regenerates and restarts the gateway. test-console\start.cmd runs the UI. Modes: stub, hosted, ollama, ollama-cpu (switch-models.ps1 -To <mode>).
- UI: the model pick list (sticky in localStorage, default from the registry). Private chat now separates the question from the attached data (data kept in page memory only), lists earlier answers with "Use in next question" checkboxes (sent as assistant turns), shows a size line, and has New conversation.

Key facts:
- The gateway caps chat at 48,000 characters and estimates tokens as characters / 4. A request needs prompt + max output <= the model context (routing/select.ts failedFilter). Room: about 48k characters for 1.5b/qwen, about 16k for the 8b.
- R1 thinking arrives in a separate "reasoning" field and shares the output budget. An empty answer is rejected by dispatch.ts parseCompletion (upstream_error with status 200, then 503 and a 30 s cooldown).
- The default model must be scored fast as well (speed bonus on easy questions in routing/scores.ts). Fixed in the generator.
- The 1.5b is unreliable on facts (said Mumbai, Panipet); the 8b is correct.
- Don't use `npm --prefix services/paywall install` (it adds "chainaim-router": "file:../.." and breaks the paywall build). Run `npm install` inside services\paywall. Node >= 22.22 (24.22 is installed).
- In PowerShell, use Invoke-RestMethod with a single-quoted JSON body, not curl.exe -d.

Not yet verified:
- The new Private chat (question/data separation, follow-ups) in a real browser.
- Whether the 8b at ctx 12288 shows "100% GPU" in `ollama ps`. If it doesn't, set its numCtx to 8192 in config\local-models.json and rerun use-ollama.cmd.

Next step:
Help me test the new Private chat. Restart start.cmd, press Ctrl+F5, pick local/deepseek-r1-8b, attach a statement once, ask "What was my non-online spend? List the transactions.", then follow up with "What is the total of those, and which one is the largest?" without re-attaching. Check the size line, an unticked answer, and New conversation. Then look at `ollama ps` for the 8b.

Then the open items, in order: per-model temperature in the registry; a quality/benchmark script (scripts\local-eval.ts with --models --cases --runs, reusing eval\ and scripts\iter0-matrix.ts if suitable); a Presidio masking check on real statements; the reconciliation service design (decisions needed: tax-return format CSV or PDF, and which source pairs to reconcile); fixing the setup .docx.

Working rules: read the files before claiming anything; label anything inferred; real, flag-driven implementations only; split AI work from my manual steps and give me manual steps one at a time.
```
