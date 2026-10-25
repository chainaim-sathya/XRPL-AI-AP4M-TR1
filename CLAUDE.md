# Project rules

This project is built from `architecture.md` by an agent loop. These rules are
not advice. Hooks enforce several of them mechanically.

## The non-negotiables

1. **No mocks, stubs, placeholders or deferred work.** No `TODO`, no `FIXME`,
   no "for now", no fake data, no function that returns a hardcoded sample.
   Every line you write must be the real implementation. A `PostToolUse` hook
   scans every file you write and will reject it.

2. **Everything traces to an ARCH-ID.** `architecture.md` numbers every
   requirement (`ARCH-001`, `ARCH-002`, ...). Every task in `TASKS.md` cites the
   ARCH-ID it satisfies. Every test name carries its ARCH-ID. Code that
   satisfies no ARCH-ID should not exist; an ARCH-ID with no passing test is a
   gap and must be reported, not quietly skipped.

3. **"Done" means it ran.** Reading code is not verification. A task is done
   only when you executed the real command and captured the real output into
   `BUILD_LOG.md`. A `Stop` hook re-runs typecheck and tests and will not let
   you end your turn while they fail.

4. **Never weaken a test to make it pass.** Do not delete, skip, loosen or
   `.only` a test. Do not catch and swallow an error to go green. If the
   implementation is wrong, fix the implementation.

5. **Never use git.** No `git add`, `commit`, `push`, `checkout`, `reset`,
   `branch`, `stash` — none of it. The user handles version control by hand.
   This is denied in settings; do not look for a way around it. Use
   `node .claude/hooks/snapshot.js --label task-NN` for rollback points.

6. **Document manual steps as you go, never at the end.** The moment you write
   code that reads an environment variable, calls a third-party API, or needs a
   running service, append the entry to `MANUAL_SETUP.md` in that same turn.
   The end-of-run report formats this file; it does not invent it. A hook
   enforces this for environment variables.

7. **When blocked, stop — do not improvise.** If a real implementation needs
   something you do not have (a credential, an account, a running service,
   access to a private API), you may not fake it. Record the blocker in
   `STATE.md`, add the requirement to `MANUAL_SETUP.md`, and move to the next
   independent task.

## Configuration

`build.config.json` holds every tunable value: the test/typecheck/build
commands, the retry policy, the mock patterns, the file names. Read it before
running anything. Never hardcode a command that lives in that file, and never
edit a hook to get around a gate.

## Working files

| File | Who writes it | What it is |
|---|---|---|
| `architecture.md` | the user | The spec. Ground truth. Never edit it. |
| `TASKS.md` | `/plan` | Ordered tasks, each with an ARCH-ID and acceptance criteria |
| `PREREQS.md` | `/plan` | What the user must set up **before** the build starts |
| `STATE.md` | the build loop | Current task, attempts, blockers. Resume point. |
| `BUILD_LOG.md` | the build loop | Append-only. One entry per task, with real command output. |
| `MANUAL_SETUP.md` | every agent | Append-only. What the user must do by hand. |
| `BUILD_REPORT.md` | `/report` | Final summary |

`STATE.md` must be updated after **every** task. If context is compacted or the
session dies, `STATE.md` is the only thing that lets the build resume.

## How to work

- One task at a time. Finish it, verify it, log it, update `STATE.md`, then take
  the next one. Do not start three tasks at once.
- Snapshot before each task: `node .claude/hooks/snapshot.js --label task-NN`.
- Use subagents for reading-heavy work (search, review, audit). Their context is
  separate, so only their conclusion costs the main thread tokens.
- Do not re-read `architecture.md` in full on every turn. Read the section for
  the ARCH-ID you are working on.
- Prefer real local services (`docker compose up -d`) over any form of fake. If
  a dependency has no real local option, that is a blocker, not a licence to mock.

## Style

- Make behaviour configurable with explicit flags and named arguments with
  sensible defaults, not hardcoded constants buried in the implementation.
- Handle errors properly. No empty catch blocks, no swallowed exceptions.
- Never write a real secret into any file, including examples. Use
  `.env.example` with empty values.
