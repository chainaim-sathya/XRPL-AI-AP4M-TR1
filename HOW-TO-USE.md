# How to use this harness

A build harness for Claude Code. You write `architecture.md`, walk away, and come
back to working code plus two reports.

## One-time setup

**1. Set your stack commands.** Open `build.config.json` and set
`commands.test`, `typecheck`, `lint`, `build`, `install`, `servicesUp`. These are
the defaults for a Node project; change them for yours. The gates run these exact
strings — wrong commands means gates that pass without checking anything.

**2. Check Node is on PATH.** The hooks are Node scripts. In a terminal:
`node --version`. If that fails, nothing here fires.

**3. Smoke-test the hooks** before trusting them:

```
node .claude/hooks/no-mocks.js --dry --file build.config.json
node .claude/hooks/gate-done.js --check
node .claude/hooks/snapshot.js --dry --label test
```

`--check` will fail until the project actually has tests. That is expected.

## The run

```
/plan      architecture.md -> TASKS.md + PREREQS.md
           << YOU REVIEW TASKS.md HERE — the one checkpoint that matters >>
           << YOU DO THE PREREQS.md ITEMS — keys, accounts, services >>
/build     the loop: snapshot -> implement -> verify -> log -> next task
/audit     independent ARCH-ID coverage check + code review
/report    BUILD_REPORT.md + MANUAL_SETUP.md
```

Reviewing `TASKS.md` takes ten minutes. Skipping it is how you get a confidently
wrong build six hours later.

Doing `PREREQS.md` *before* `/build` is what stops the run stalling at 3am on a
missing API key.

## What is enforced, and how

| Rule | Enforced by | What happens |
|---|---|---|
| No mocks or placeholders | `no-mocks.js` on every file write | Claude is told to fix it immediately |
| Manual steps documented | `env-doc.js` on every file write | Reading a new env var without documenting it is rejected |
| Tests must pass before "done" | `gate-done.js` on Stop | Claude cannot end its turn while they fail |
| No git | `permissions.deny` in settings | `git` commands are blocked outright |
| No secrets read | `permissions.deny` | `.env` cannot be read into context |

The Stop gate only runs while `.claude/.build-active` exists, so normal
conversation is not gated. `/build` creates it; `/report` removes it. If a gate
ever fires when you are just chatting, delete that file.

## Files the build produces

| File | What it is |
|---|---|
| `TASKS.md` | The plan. Review this. |
| `PREREQS.md` | Do these **before** building. |
| `STATE.md` | Resume point. Survives a dead session. |
| `BUILD_LOG.md` | Append-only, one entry per task with real output. |
| `AUDIT.md` | Independent coverage check and review. |
| `BUILD_REPORT.md` | What happened. |
| `MANUAL_SETUP.md` | Your checklist, plain English, one action per step. |

## Comparing runs

Every `/build` archives its reports into `reports/<timestamp>__tasks-NN-NN/` and
appends a row to `reports/INDEX.md`. Read the index first — one line per run,
with outcome, coverage and audit verdict — then open a folder to see that run's
report, audit, log and a snapshot of the manual-setup checklist as it stood then.
Nothing is ever overwritten; with no git in this project, this archive is the
only history you have.

```
node .claude\hooks\report-run.js --list
```

`STATE.md`, `TASKS.md` and `MANUAL_SETUP.md` deliberately stay in the root.
`STATE.md` is the resume point, and `MANUAL_SETUP.md` is the fixed path the
env-doc hook checks against on every file write — move it and every write gets
rejected. Turn archiving off with `reports.enabled` in `build.config.json`.

## Rolling back without git

Snapshots are taken before each task:

```
node .claude/hooks/snapshot.js --list
node .claude/hooks/snapshot.js --restore task-07          (shows the plan)
node .claude/hooks/snapshot.js --restore task-07 --confirm
```

## Tuning

Everything lives in `build.config.json`:

- `policy.maxAttemptsPerTask` — retries before a task is marked BLOCKED (3)
- `policy.onTaskFailure` — `skip-and-continue` or `stop`
- `noMocks.patterns` — add or remove markers; `allowInPaths` exempts paths
- `gate.runOnStop` — which commands the Stop gate runs
- `snapshots.ignorePaths` — what not to copy

If a gate throws false positives, loosen it here. Do not let an agent edit the
hooks — that is the one change that quietly disables the whole thing.

## Known limits

- The Stop gate is a nag, not a wall: Claude Code overrides a Stop hook after 8
  consecutive blocks. That is why `/audit` re-runs the suite independently
  instead of trusting `BUILD_LOG.md`.
- `no-mocks.js` is a text scan. It catches careless placeholders, not clever
  ones. The auditor is the real backstop.
- Vague acceptance criteria produce vague code. The harness cannot fix a vague
  `architecture.md`.
- Expect to walk away for one module at a time, not a whole greenfield system.
  Scale up once you trust it.
