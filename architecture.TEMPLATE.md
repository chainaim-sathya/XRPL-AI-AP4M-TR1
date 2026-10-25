# <Project name> — Architecture

> TEMPLATE. Copy to `architecture.md`, replace everything in angle brackets, and
> delete these quote blocks.
>
> The one rule that makes this whole harness work: **every requirement gets an
> ARCH-ID and an acceptance criterion a command can prove.** Without IDs, "did it
> follow the architecture?" is an opinion. With them, it is a checklist.

## 1. What this is

<Two or three sentences. What the system does and who uses it.>

## 2. Stack and constraints

- Language / runtime: <e.g. TypeScript, Node 20>
- Framework: <...>
- Data store: <...>
- Test runner: <...>
- Must run on: <Windows / Linux / both>
- Hard constraints: <things that are not negotiable>

> Set `build.config.json` -> `commands` to match this stack before building.
> Those exact strings are what the verification gate runs.

## 3. Components

| Component | Responsibility | Talks to |
|---|---|---|
| <name> | <one sentence> | <...> |

## 4. Data flow

<Describe the main paths in words or a simple list. Where does a request enter,
what touches it, where does state land.>

## 5. External dependencies

| Service | Used for | Real local option | Credential needed |
|---|---|---|---|
| <Postgres> | <persistence> | `docker compose up -d` | no |
| <OpenAI API> | <embedding> | none — needs real key | `OPENAI_API_KEY` |

> Anything with no real local option will become a blocker, not a mock. List it
> here so it lands in `PREREQS.md` and you can set it up before the build starts.

---

# Requirements

> Numbering: `ARCH-001` upward. Never renumber after a build has started — the
> IDs are referenced from TASKS.md, test names and BUILD_LOG.md.
>
> Each requirement needs an acceptance criterion that a command can prove. If you
> cannot write such a criterion, the requirement is too vague and the build will
> interpret it freely.
>
> Headings must be `### ARCH-NNN — title` so `plan-check.js` can count them.

### ARCH-001 — <short title>
**Requirement:** <what MUST be true. Use MUST / MUST NOT, be specific about
numbers, limits and units.>

**Acceptance:** <an observable check. "Running `npm test -- auth` passes a test
named `ARCH-001: ...` which posts an expired token and asserts a 401 response.">

**Notes:** <edge cases, things explicitly out of scope>

---

### ARCH-002 — <short title>
**Requirement:** <...>

**Acceptance:** <...>

---

## Out of scope

<List what this build deliberately does not cover. Anything not written down
here and not an ARCH-ID is scope creep, and the plan reviewer will flag it.>

---

> ## Good vs bad acceptance criteria
>
> Bad: "The API should be fast and reliable."
> Good: "`npm test -- perf` asserts p95 latency under 200ms over 100 sequential
> requests against the local instance."
>
> Bad: "Handle errors properly."
> Good: "When the database is unreachable, `GET /orders` returns 503 with body
> `{"error":"upstream_unavailable"}` and logs at level error. Test:
> `ARCH-0NN: returns 503 when db is down` stops the container and asserts this."
>
> Bad: "Store user settlements."
> Good: "On a FILL event, a row MUST appear in `settlements` with
> `status='SETTLED'` within 2 seconds. Test publishes a FILL and polls the table."
>
> The test: could someone write a command that returns pass or fail from this
> sentence alone? If not, rewrite it.
