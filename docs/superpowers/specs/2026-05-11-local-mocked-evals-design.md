# Local mocked evals — design

- **Date:** 2026-05-11
- **Status:** Draft, pending user review
- **Author:** Adam Harris (with Claude)
- **Related skill:** [`.claude/skills/run-evals/SKILL.md`](../../../../.claude/skills/run-evals/SKILL.md)

## Background

`run-evals` today runs prompts against the deployed `clis-worker` on Render.
Every iteration burns real Anthropic API budget (Haiku 4.5) plus real
third-party API calls (Slack, Contentful, GA4, scrape-creators). For the
recipe-tuning loop (edit addendum → re-run → see if turn count dropped) this
is the wrong cost shape. The eval is supposed to be the *test* in the
edit-test loop, not a $1+ commit.

The user has a Claude MAX subscription and proposed treating evals "like
mocks and tests": a fast local loop using mocked CLI output, with the
deployed eval reserved for integration-test moments (pre-merge, periodic
drift check). This spec defines that local mode.

## Goals

1. **Free local iteration.** Editing a recipe and re-running the eval
   incurs no LLM cost (uses MAX session) and no third-party API cost
   (mocked CLI responses).
2. **Honest signal.** Local eval runs the actual `clis-worker` Hono server,
   not a re-implementation. The only knob that changes vs. deployed is
   "real CLIs replaced by cassettes."
3. **Privacy-safe cassettes.** Recordings of real API output are
   anonymized on the fly so they're committable to the worker repo
   without leaking client data.
4. **Deterministic across machines.** A teammate cloning the repo can
   run the same eval and get comparable numbers without re-recording.

## Non-goals

- **Schema-drift detection.** If Slack adds a new field, our cassette
  is missing it. We accept this; the deployed eval is the integration
  check.
- **Adversarial PII protection.** Anonymization is structure-preserving
  and deterministic. Someone with the original data could verify "is X
  in this cassette" by hashing X. The threat model is "don't put raw
  client data in git," not "defeat reconstruction."
- **Concurrent record sessions.** Single-user assumption.
- **Replacing the deployed eval.** Local is for fast iteration; deployed
  remains the source of truth for "did this recipe save real $cost on
  real Haiku."

## Design decisions log

| # | Decision | Chosen | Alternatives considered |
|---|---|---|---|
| 1 | Recording strategy | **VCR-style cassettes** (record once, replay forever) | Hand-written fixtures; hybrid seed-then-maintain |
| 2 | Fixture location | **In-repo at `clis-worker/eval-fixtures/`** with on-the-fly anonymization | Workspace-sibling private repo; per-machine `~/printing-press/eval-fixtures/`; in-repo without anonymization |
| 3 | Anonymization | **Auto-detect + field-name deny list + per-CLI overrides**, deterministic hash replacement, audit log per cassette | Hand-curated per-CLI rules from day one; record-then-review-each |
| 4 | Missing-fixture behavior | **Tiered**: hard fail by default (`replay`), opt-in passthrough (`record-missing`) | Always hard fail; always passthrough |
| 5 | Local agent loop | **Spawn the actual `clis-worker` Hono server** as subprocess with mocked CLIs on PATH | Dispatch subagents inside this Claude Code session |

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│ run-evals --local  (skill, this Claude Code session)     │
└───────────────────────────────────────────────────────────┘
                          │
                          ▼
┌───────────────────────────────────────────────────────────┐
│ scripts/local-eval.ts (orchestrator)                      │
│  • spawns clis-worker as subprocess                       │
│  • sets PATH=<eval-mocks/bin>:$PATH                       │
│  • sets EVAL_MOCK_MODE={replay|record|record-missing}     │
│  • waits for /health, then sends prompts serially         │
│  • captures result events → baseline.json / after.json    │
└───────────────────────────────────────────────────────────┘
              │ spawns                      │ POST /agent
              ▼                             ▼
   ┌─────────────────────┐   ┌──────────────────────────────┐
   │  clis-worker (Hono) │   │  Agent SDK loop               │
   │  unmodified         │   │  uses MAX session via         │
   │                     │   │  Claude Code subprocess       │
   └─────────────────────┘   └──────────────────────────────┘
              │ Bash exec
              ▼
   ┌──────────────────────────────────────────────────────────┐
   │  mock-cli dispatcher                                     │
   │  • single Node script, symlinked as each CLI name        │
   │  • argv[0] = which CLI; argv[1..] = original args        │
   │  • computes fixture key, looks up cassette               │
   │  • replay  → echoes recorded stdout/stderr, exits with   │
   │              recorded code                               │
   │  • record  → execs real CLI, anonymizes, persists, returns│
   │  • miss    → exit 87 with "EVAL_MOCK_MISS"               │
   └──────────────────────────────────────────────────────────┘
              │
              ▼
   ┌──────────────────────────────────────────────────────────┐
   │  clis-worker/eval-fixtures/                              │
   │    <cli>/<command-slug>__<argshash>.json    (cassette)   │
   │    <cli>/<command-slug>__<argshash>.audit.json (redactions)│
   │    .anonymize/global.yaml                                │
   │    .anonymize/<cli>.yaml                                 │
   │    .env.eval                                             │
   │    INDEX.md (auto-generated)                             │
   └──────────────────────────────────────────────────────────┘
```

**Key invariant:** the worker is unmodified. The only thing different
between local and deployed is what's on `PATH`. That keeps the eval an
honest predictor of deployed behavior.

## Components

| # | Component | Path | Responsibility |
|---|---|---|---|
| 1 | **mock-cli dispatcher** | `eval-mocks/src/dispatcher.ts` (compiled to `eval-mocks/bin/<cli-name>` symlinks) | argv[0]-based CLI identity. Computes fixture key from cmd + stdin + env subset. Routes to fixture store based on `EVAL_MOCK_MODE`. |
| 2 | **fixture store** | `eval-mocks/src/store.ts` + `eval-fixtures/` data dir | Read/write cassettes (atomic), append audit logs, regenerate `INDEX.md` on changes. |
| 3 | **anonymizer** | `eval-mocks/src/anonymizer.ts` + `eval-fixtures/.anonymize/*.yaml` | Walks JSON output, applies global pattern rules + per-CLI field rules. Deterministic hash replacement (`hash(real)[:8]` → `entry_a4b9c2d1`) for reference integrity without state. |
| 4 | **eval-runner** | `clis-worker/scripts/local-eval.ts` | Spawns worker on `EVAL_PORT` (default 3787), sets PATH/env, polls `/health`, sends prompts serially, writes `baseline.json`/`after.json` to `eval-runs/<date>-<slug>/`. |
| 5 | **comparison reporter** | `clis-worker/scripts/eval-report.ts` | Same delta table as deployed eval, minus `$cost`, plus `tool_calls`, `mock_misses`, optional `samples` columns. |
| 6 | **skill update** | `.claude/skills/run-evals/SKILL.md` | Adds `--local` (synonym `--mocked`) flag. Without flag → existing deployed flow. With flag → orchestrates 1–5. |

### Component design notes

- **Dispatcher in TypeScript** (not Go) so it lives next to the worker
  in the same toolchain. ~50–100ms startup overhead is acceptable for
  agent tool calls (O(10) per prompt).
- **Symlinks generated from `SYSTEM_PROMPT`.** The orchestrator parses
  the canonical CLI list out of `clis-worker/src/server.ts` and creates
  the symlinks. One source of truth; no manual upkeep when CLIs are added.
- **Stateless / deterministic anonymizer.** No shared identity-map.json
  to keep in sync. Same real ID → same fake ID, derived purely from
  `hash(real_value)`. Preserves reference integrity for free across all
  cassettes.
- **Fixture filename format:** `<command-slug>__<8charhash>.json`. Slug
  answers "what is this?" for ~90% of cases without opening the file.
  Hash disambiguates and guarantees uniqueness when slugs collide
  (long arg lists). Audit file matches: `<slug>__<hash>.audit.json`.

## Data flow

### Replay path (normal eval run)

```
1. local-eval.ts spawns clis-worker subprocess with:
     PATH=clis-worker/eval-mocks/bin:$PATH
     EVAL_MOCK_MODE=replay
     EVAL_FIXTURE_DIR=clis-worker/eval-fixtures
     EVAL_PORT=3787
     <fake env vars from eval-fixtures/.env.eval>

2. local-eval.ts polls localhost:3787/health, then loops prompts:
     POST /agent {prompt: "List the public Slack channels..."}

3. Worker invokes Agent SDK → Claude Code subprocess (MAX session)

4. Model decides to call Bash: "slack-pp-cli channels list --agent"
     → resolves on PATH to eval-mocks/bin/slack-pp-cli
     → which is a symlink to dispatcher.js

5. Dispatcher:
     a. Reads argv[0] → "slack-pp-cli"
     b. Reads argv[1..] → ["channels", "list", "--agent"]
     c. Reads stdin (if any) → ""
     d. Computes key:
          slug    = "channels-list--agent"
          hash    = hash(JSON.stringify({argv, stdin, env_subset}))[:8]
          path    = eval-fixtures/slack-pp-cli/channels-list--agent__a4b9c2d1.json
     e. Reads cassette → echoes recorded stdout, exits with recorded code

6. Agent gets the response, continues loop, eventually emits {type:"result"}

7. local-eval.ts captures the result event, appends to baseline.json
```

### Record path (first time / `EVAL_MOCK_MODE=record`)

Steps 1–5d identical. At 5e:

```
e. Cassette miss → execs the REAL CLI with same argv/stdin/env
f. Captures stdout, stderr, exit code
g. Pipes JSON output through anonymizer:
     - Walks the parsed object
     - Applies global rules (.anonymize/global.yaml) for emails/phones/URLs
     - Applies per-CLI rules (.anonymize/<cli>.yaml) for field-name matches
     - Each replaced value: stable hash (e.g. "U07X9..." → "user_a4b9c2d1")
     - Records the replacements in audit.json
h. Writes:
     <slug>__<hash>.json        (anonymized cassette)
     <slug>__<hash>.audit.json  (what was redacted, by JSON path)
i. Returns the anonymized output to the agent (so the agent sees what
   it would see in any future replay — no behavioral difference)
```

### Env var expansion (the gotcha)

Prompts contain `$CONTENTFUL_SPACE_ID`. The agent passes that literal to
Bash, where the worker's shell expands it. For mocks to key
deterministically across machines, we pin canonical eval values:

```
# eval-fixtures/.env.eval (committed)
CONTENTFUL_SPACE_ID=eval_space_001
SLACK_BOT_TOKEN=eval_slack_token
GA4_PROPERTY_ID=eval_property_001
SCRAPECREATORS_API_KEY=eval_sc_key
# (real secrets stay in your shell / Render dashboard for record mode)
```

`local-eval.ts` loads `.env.eval` before spawning the worker. The model
sees expanded values like `eval_space_001`, the mock keys on those,
cassettes are stable. **Record mode** overrides with real values from
the user's shell `.env` so it can actually call real APIs.

### Stdin handling

Some CLIs take piped JSON (e.g. the slack `--stdin` workaround for
POST endpoints). Dispatcher reads stdin into the key calculation, so
`... | slack-pp-cli post --stdin` keys on the stdin content too.
Cassette files include the stdin in `request` for human review.

### Argv normalization

Default: **flag-order-insensitive**. The dispatcher sorts `--flag value`
pairs, keeps positional args in order, and uses the normalized form for
the hash. Avoids spurious misses when the agent reorders flags between
runs. Per-CLI override available if a CLI is order-sensitive (printing
press CLIs are not). Normalization is recorded in the audit so reviewers
see what changed.

## Error handling

### 1. Cassette miss in replay mode

Exit code 87 is reserved as "mock miss" (deliberately not in worker's
standard 0/2/3/4/5/7 set):

```
$ slack-pp-cli channels list --filter is_member=true
EVAL_MOCK_MISS slack-pp-cli channels-list--filter-is-member=true
  expected fixture: eval-fixtures/slack-pp-cli/channels-list--filter-is-member=true__7c2e91a3.json
  re-record with: EVAL_MOCK_MODE=record-missing npm run local-eval
exit code: 87
```

The eval-runner scans tool outputs for `EVAL_MOCK_MISS`. Any prompt
whose transcript contains that string is flagged in `report.md` as
**degraded** — the turn/duration numbers for that row are not
comparable. Avoids false-positive "cost reduction" from a tool failing
fast.

### 2. Anonymizer fails

- **Non-JSON output** (e.g. `doctor` prose): logs `skipped: non-JSON` to
  audit and applies a global string-pattern pass (email regex, phone
  regex) before passing the raw output through.
- **Anonymizer exception** (circular ref, unknown rule type): refuses to
  write the cassette and exits non-zero with the failing rule path.
  Better to fail loudly than commit raw client data.

### 3. Worker subprocess won't start

Eval-runner waits up to 60s on `/health`. On failure: kills the worker
subprocess, dumps stderr to `eval-runs/<date>-<slug>/worker-stderr.log`,
aborts the eval with the captured error.

### 4. MAX session unavailable

If the Agent SDK can't find a Claude Code session AND no
`ANTHROPIC_API_KEY` is set, the worker errors on first `/agent` call.
Eval-runner catches the first failure, surfaces:

```
Local eval requires either:
  (a) Claude Code logged in with a paid plan, or
  (b) ANTHROPIC_API_KEY set in your shell.
```

…and aborts before sending the rest of the prompts. A `local-eval --check`
preflight hits a tiny "say hi" prompt before iterating the real set, so
this fails in 5 seconds, not after 3 prompts.

### 5. Cassette drift over time

Each cassette stores `recorded_at` and the real CLI version (captured
via `<cli> --version` at record time). The reporter prints a warning at
the top of `report.md` if any cassette used in the run is >90 days old
or recorded against a different CLI version than the one currently
installed. No automatic re-record.

### Explicitly not handled

- Schema drift detection (deployed eval covers this).
- Concurrent record sessions (single-user assumption; no locking).
- Partial recordings (re-running with `record-missing` resumes naturally).

## Testing

### Unit tests (Vitest, runs via `npm test`)

Vitest needs to be added to `clis-worker/devDependencies` — the worker
has no test runner today. Alternative: Node's built-in `node:test`
(zero new deps, less ergonomic). See open questions.

| Module | Test surface |
|---|---|
| **anonymizer** | Each replacement strategy preserves JSON shape (no field added/removed/typed-changed). Same input → same output across N invocations. Reference integrity: same value at two paths → same fake value. PII patterns (email, phone, URL with embedded ID) caught by global rules. Per-CLI override beats global rule. Non-JSON output is pattern-scanned, not parsed. |
| **dispatcher key computation** | argv normalization (whitespace, quote handling, flag-order insensitivity), stdin inclusion, env-whitelist filtering. |
| **fixture store** | Write/read round-trip preserves bytes. Audit log captures every replacement. INDEX.md regenerates correctly when cassettes added/removed. Atomic writes (no half-written cassettes if dispatcher crashes mid-write). |

### Integration test: fake-pp-cli end-to-end

A tiny `eval-mocks/test/fake-pp-cli` shell script that always returns
`{"users":[{"email":"alice@example.com","id":"U001"}]}`. Test sequence:

1. `EVAL_MOCK_MODE=record` invoke the dispatcher pretending to be
   `fake-pp-cli` → assert a cassette was written, email was scrubbed,
   audit log recorded the redaction.
2. `EVAL_MOCK_MODE=replay` invoke again with same args → assert output
   is byte-identical to the cassette, no real CLI invoked (verifiable:
   rename `fake-pp-cli` away — replay still works).
3. `EVAL_MOCK_MODE=replay` with different args → assert exit 87,
   `EVAL_MOCK_MISS` in stderr.

This exercises the whole record/replay/miss path without touching
real APIs.

### Smoke test: one-prompt eval against the real worker

An `npm run local-eval:smoke` target that:

- Spawns the worker.
- Sends a single canned prompt that maps to one cassette command
  (`slack-pp-cli doctor --agent` — exercises the Bash path with the
  smallest-possible response).
- Asserts: `/health` returned 200, prompt produced a `result` event,
  cassette was hit (verifiable from audit), no `EVAL_MOCK_MISS`.

Tripwire for "did anything in the eval pipeline break." Runs in <10s.
Should run in CI on every clis-worker PR.

**Bootstrap dependency:** the smoke test requires the
`slack-pp-cli doctor` cassette to exist. First-time setup is a
one-shot record run against the real Slack token. The committed
cassette then makes subsequent CI runs hermetic. If the cassette
is missing, the smoke test fails with a clear "run `npm run local-eval
-- --mode=record --prompts=smoke` first" message rather than
silently passing.

### Stability check (opt-in)

LLM nondeterminism means the same prompt against the same cassettes
can produce 8 turns one run and 11 turns the next.

`--samples N` flag on `local-eval` runs each prompt N times and reports
mean ± stdev. Default N=1 (fast iteration). Use N=3 before declaring a
recipe a win. Adds the column `turns_after (mean±sd)` to the report.
3× wall-clock; free on MAX.

## Skill integration

### `run-evals` flag changes

New `--local` flag (synonyms: `local`, `--mocked`). Default behavior
unchanged.

| Phase | Deployed (no flag) | Local (`--local`) |
|---|---|---|
| 0. Setup | Confirm `WORKER_API_KEY`, `WORKER_URL` | Confirm `clis-worker/eval-mocks/bin/` exists; warn if no Claude Code MAX session detected |
| 1. Baseline | Curl deployed worker | Spawn worker subprocess + curl `localhost:3787` |
| 2. Review | `review-worker-transcripts` against deployed `/transcripts` | Same skill, against `eval-runs/<date>-<slug>/baseline-transcripts/` |
| 3. Apply | Edit recipe files, commit locally, ask "push it?" | Same; no push needed for local-only iteration |
| 4. Push & redeploy | Push → wait for Render | **Skipped** for `--local` |
| 5. After-eval | Curl deployed | Spawn worker again, curl localhost |
| 6. Report | Existing format | Same minus `$cost`, plus `tool_calls`, `mock_misses`, optional `samples` |

### Comparison report shape

```
prompt (60ch)            | turns      | tool_calls | duration_ms | mock_misses | status
                          before→after| before→after| before→after|             |
─────────────────────────┼─────────────┼─────────────┼─────────────┼─────────────┼────────
Slack: list channels      |  8 → 5  ✓  |  4 → 2 ✓   |  12k → 7k   |   0 → 0     | OK
Contentful: orphans       | 14 → 14    | 11 → 11    |  31k → 30k  |   0 → 0     | NO CHANGE
Trends triangulate        |  9 → 12 ✗ |  5 → 8 ✗   |  18k → 26k  |   0 → 1 ⚠   | DEGRADED
                                                                                  (mock miss)
─────────────────────────┴─────────────┴─────────────┴─────────────┴─────────────┴────────
Aggregates: turns -3 (-10%), tool_calls -1 (-5%), 1 prompt regressed (1 degraded by miss)
Recipes added: 1 → clis-worker/docs/addenda/slack-pp-cli.md
Stability: --samples 1 (turn counts have ±1-2 noise; re-run with --samples 3 to confirm)
```

`tool_calls` is the new headline metric. Cleanest proxy for "did the
agent flail" — turns vary ±1–2 from LLM noise; tool_calls dropping from
11→4 is unambiguous.

### Cost discipline

`--local` mode lifts the $5 cap (no LLM cost). Deployed eval still
enforces it: count proposed prompts × ~$0.05 × 2, refuse to start if
>$5 without explicit user override.

### Promotion path

After local says "this recipe drops `tool_calls` by 50%", user runs
deployed eval to confirm the saving translates to real $cost. The
local report's last line suggests this:

```
✓ Local eval shows 1 recipe candidate paid off (-3 turns, -1 tool_call avg).
Suggest: run-evals (deployed) to confirm $cost reduction before pushing.
```

### Port collision

Local-eval uses `EVAL_PORT` (default 3787), not 3000. Avoids collision
with any concurrent `npm run dev`.

## Open questions / deliberate looseness

1. **Anonymization of prose `doctor` output.** Global pattern pass
   (email, phone regex) handles the 80% case. If a `doctor` message
   includes something exotic (e.g. an account display name), it might
   leak. Mitigation: review the first cassette of each CLI's `doctor`
   command after recording. After that, the cassette is stable.
2. **Argv normalization edge cases.** Flag-order-insensitive sorting
   assumes `--flag value` and `--flag=value` are equivalent. Dispatcher
   normalizes both to the same canonical form. CLIs that use repeated
   flags (`--include a --include b`) need order preserved within the
   repeated set; will be handled by treating repeated flags as a list.
3. **Cassette regeneration policy.** No auto re-record when stale.
   Leave the decision to the user; reporter surfaces age warnings.
4. **Test runner choice.** Vitest vs `node:test`. Vitest has better
   ergonomics (watch mode, snapshot testing, friendly assertions);
   `node:test` adds zero deps. Defaulting to Vitest in this spec; can
   flip in the implementation plan if "no new deps" wins.

## Out of scope

- A UI for browsing cassettes (the auto-generated `INDEX.md` is the
  browsing UI).
- Diffing two cassettes (e.g. "what changed when I re-recorded?") —
  git diff handles this fine.
- Running local eval in CI against deployed-shape Haiku results — would
  require Anthropic API key in CI and defeats the point of "free local."
- Mocking the Agent SDK's model calls themselves. We mock CLIs; the
  agent loop is the real worker code with the real (MAX) model.
