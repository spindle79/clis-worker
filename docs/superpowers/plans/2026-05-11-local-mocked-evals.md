# Local mocked evals — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local, MAX-backed eval mode for `clis-worker` that replaces real CLI invocations with VCR-style cassettes, so the recipe-tuning loop iterates without paying Anthropic API or third-party API cost.

**Architecture:** A TypeScript "mock-cli" dispatcher binary, symlinked under each CLI name, intercepts Bash tool calls from the worker. In replay mode it serves recorded JSON cassettes; in record mode it executes the real CLI, anonymizes output, and persists. The actual `clis-worker` Hono server runs unmodified — only `PATH` changes. An orchestrator script spawns the worker, sends prompts serially, and writes a delta report.

**Tech Stack:** Node 24, TypeScript, Vitest, Hono (existing worker), `js-yaml` for rule files, `@anthropic-ai/claude-agent-sdk` (existing, uses MAX session via local Claude Code subprocess).

**Spec:** [`../specs/2026-05-11-local-mocked-evals-design.md`](../specs/2026-05-11-local-mocked-evals-design.md)

**Working dir for all tasks:** `/Users/adamharris/Documents/repos/clis/clis-worker/` unless noted otherwise.

---

## Task 1: Project setup — deps, dirs, gitignore, scripts

**Files:**
- Modify: `clis-worker/package.json`
- Modify: `clis-worker/.gitignore`
- Create: `clis-worker/eval-mocks/src/.gitkeep`
- Create: `clis-worker/eval-mocks/scripts/.gitkeep`
- Create: `clis-worker/eval-mocks/test/.gitkeep`
- Create: `clis-worker/eval-mocks/test/fixtures/.gitkeep`
- Create: `clis-worker/eval-mocks/bin/.gitkeep`
- Create: `clis-worker/eval-fixtures/.gitkeep`
- Create: `clis-worker/eval-fixtures/.anonymize/.gitkeep`
- Create: `clis-worker/eval-fixtures/.env.eval`

- [ ] **Step 1: Add devDeps and scripts to `package.json`**

Edit `package.json` to add `vitest`, `js-yaml`, `@types/js-yaml` to devDependencies, and the new scripts:

```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/server.js",
    "dev": "tsx watch src/server.ts",
    "typecheck": "tsc --noEmit",
    "review": "tsx scripts/review.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "eval:setup": "tsx eval-mocks/scripts/setup-symlinks.ts",
    "local-eval": "tsx scripts/local-eval.ts",
    "local-eval:smoke": "tsx scripts/local-eval-smoke.ts",
    "eval:report": "tsx scripts/eval-report.ts"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^24.0.0",
    "js-yaml": "^4.1.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

(Keep existing `dependencies` section unchanged.)

- [ ] **Step 2: Update `.gitignore`**

Append to `clis-worker/.gitignore`:

```
# Eval artifacts
eval-runs/
eval-mocks/bin/*
!eval-mocks/bin/.gitkeep
worker-stderr.log
```

- [ ] **Step 3: Create directory scaffolding**

```bash
cd /Users/adamharris/Documents/repos/clis/clis-worker
mkdir -p eval-mocks/src eval-mocks/scripts eval-mocks/test/fixtures eval-mocks/bin
mkdir -p eval-fixtures/.anonymize
touch eval-mocks/src/.gitkeep eval-mocks/scripts/.gitkeep eval-mocks/test/.gitkeep
touch eval-mocks/test/fixtures/.gitkeep eval-mocks/bin/.gitkeep
touch eval-fixtures/.gitkeep eval-fixtures/.anonymize/.gitkeep
```

- [ ] **Step 4: Create `eval-fixtures/.env.eval`**

```
# Pinned env vars for replay mode. Real secrets stay in your shell .env
# (used in record mode). These canonical fake values keep cassettes
# deterministic across machines.
CONTENTFUL_SPACE_ID=eval_space_001
CONTENTFUL_DELIVERY_TOKEN=eval_cf_delivery
CONTENTFUL_MANAGEMENT_TOKEN=eval_cf_management
SLACK_BOT_TOKEN=xoxb-eval-token-001
GA4_PROPERTY_ID=eval_property_001
GOOGLE_APPLICATION_CREDENTIALS=/dev/null
SCRAPECREATORS_API_KEY=eval_sc_key_001
PRESS_DATA_DIR=/tmp/eval-press-data
```

- [ ] **Step 5: Install deps**

```bash
npm install
```

Expected: vitest, js-yaml, @types/js-yaml installed without errors.

- [ ] **Step 6: Verify smoke**

```bash
npx vitest --version
```

Expected: prints a version >= 2.1.8.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitignore eval-mocks/ eval-fixtures/
git commit -m "$(cat <<'EOF'
feat(eval): scaffold eval-mocks dirs, deps, scripts, .env.eval

Adds vitest + js-yaml as devDeps and creates the directory layout for
the local mocked eval mode. eval-fixtures/.env.eval pins canonical
fake values for replay determinism.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Shared types module

**Files:**
- Create: `clis-worker/eval-mocks/src/types.ts`

- [ ] **Step 1: Write `types.ts`**

```typescript
// eval-mocks/src/types.ts
//
// Shared types across the dispatcher, store, and anonymizer.
// Schema version is embedded in cassettes so future migrations are detectable.

export const DISPATCHER_SCHEMA_VERSION = "1.0.0" as const;

export type MockMode = "replay" | "record" | "record-missing";

export interface FixtureKey {
  cli: string;       // e.g. "slack-pp-cli"
  slug: string;      // e.g. "channels-list--agent" (filesystem-safe)
  hash: string;      // 8-char hex of normalized request
}

export interface CassetteRequest {
  cli: string;
  argv: string[];               // normalized argv (sorted flag pairs)
  argv_raw: string[];           // original argv as received
  stdin: string;                // raw stdin captured at record time
  env_subset: Record<string, string>; // only env vars from CLI's whitelist
}

export interface CassetteResponse {
  stdout: string;
  stderr: string;
  exit_code: number;
}

export interface CassetteMeta {
  recorded_at: string;          // ISO8601 UTC
  cli_version: string;          // captured via `<cli> --version`
  dispatcher_version: string;   // matches DISPATCHER_SCHEMA_VERSION
}

export interface Cassette {
  request: CassetteRequest;
  response: CassetteResponse;
  meta: CassetteMeta;
}

export interface AuditEntry {
  jsonpath: string;             // e.g. "$.users[0].email"
  rule: string;                 // e.g. "global:email-pattern" or "cli:slack-pp-cli:user.id"
  original_hash: string;        // hash(real_value) — verifies which fake was used
  replacement: string;          // e.g. "user_a4b9c2d1"
}

export interface AuditLog {
  cassette: string;             // filename it pairs with
  redactions: AuditEntry[];
  notes: string[];              // e.g. "skipped: non-JSON output"
}

export interface GlobalRules {
  patterns: Array<{
    name: string;               // human label, e.g. "email"
    regex: string;              // compiled with default flags
    strategy: "hash" | "redact";
    prefix: string;             // e.g. "email_" → "email_a4b9c2d1"
  }>;
  field_names: string[];        // case-insensitive field names always scrubbed
}

export interface CliRules {
  fields: Array<{
    jsonpath: string;           // simple JSON-path subset (see anonymizer.ts)
    strategy: "hash" | "redact";
    prefix?: string;
  }>;
  env_whitelist: string[];      // env vars that affect output
  arg_normalization: "flag-order-insensitive" | "preserve-order";
  prose_doctor: boolean;        // if true, doctor output is not parsed as JSON
}

export interface AnonymizerRules {
  global: GlobalRules;
  per_cli: Record<string, CliRules>;
}

export interface AnonymizeResult {
  output: string;               // possibly-anonymized stdout
  redactions: AuditEntry[];
  notes: string[];
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors. (Existing project may emit unrelated warnings; new file should not contribute any.)

- [ ] **Step 3: Commit**

```bash
git add eval-mocks/src/types.ts
git commit -m "feat(eval): add shared types for dispatcher/store/anonymizer

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Argv normalization, slug, and key computation

**Files:**
- Create: `clis-worker/eval-mocks/src/key.ts`
- Create: `clis-worker/eval-mocks/test/key.test.ts`

- [ ] **Step 1: Write the failing test**

Create `eval-mocks/test/key.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { normalizeArgv, slugify, computeKey } from "../src/key.js";

describe("normalizeArgv", () => {
  it("preserves positional argument order", () => {
    expect(normalizeArgv(["channels", "list"], "flag-order-insensitive"))
      .toEqual(["channels", "list"]);
  });

  it("sorts --flag value pairs alphabetically", () => {
    const a = normalizeArgv(
      ["channels", "list", "--limit", "10", "--filter", "is_member"],
      "flag-order-insensitive",
    );
    const b = normalizeArgv(
      ["channels", "list", "--filter", "is_member", "--limit", "10"],
      "flag-order-insensitive",
    );
    expect(a).toEqual(b);
  });

  it("normalizes --flag=value to --flag value", () => {
    const a = normalizeArgv(["x", "--limit=10"], "flag-order-insensitive");
    const b = normalizeArgv(["x", "--limit", "10"], "flag-order-insensitive");
    expect(a).toEqual(b);
  });

  it("preserves order in preserve-order mode", () => {
    const a = normalizeArgv(["x", "--b", "1", "--a", "2"], "preserve-order");
    expect(a).toEqual(["x", "--b", "1", "--a", "2"]);
  });

  it("preserves repeated flags as ordered", () => {
    const a = normalizeArgv(
      ["x", "--include", "a", "--include", "b"],
      "flag-order-insensitive",
    );
    expect(a).toEqual(["x", "--include", "a", "--include", "b"]);
  });

  it("treats boolean flags (no value) as flags", () => {
    const a = normalizeArgv(["x", "--verbose", "--limit", "10"], "flag-order-insensitive");
    const b = normalizeArgv(["x", "--limit", "10", "--verbose"], "flag-order-insensitive");
    expect(a).toEqual(b);
  });
});

describe("slugify", () => {
  it("joins first 5 args with dashes", () => {
    expect(slugify(["channels", "list", "--agent"])).toBe("channels-list--agent");
  });

  it("truncates beyond 5 args", () => {
    const argv = ["a", "b", "c", "d", "e", "f", "g"];
    expect(slugify(argv)).toBe("a-b-c-d-e");
  });

  it("strips characters unsafe for filesystems", () => {
    expect(slugify(["path/with/slash", "name with space"]))
      .toBe("pathwithslash-namewithspace");
  });

  it("collapses consecutive dashes", () => {
    expect(slugify(["a", "", "b"])).toBe("a-b");
  });
});

describe("computeKey", () => {
  it("produces a stable 8-char hash for identical inputs", () => {
    const k = computeKey({
      cli: "slack-pp-cli",
      argv: ["channels", "list", "--agent"],
      stdin: "",
      env: { SLACK_BOT_TOKEN: "x" },
      envWhitelist: ["SLACK_BOT_TOKEN"],
      normalizeArgs: "flag-order-insensitive",
    });
    expect(k.cli).toBe("slack-pp-cli");
    expect(k.slug).toBe("channels-list--agent");
    expect(k.hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("returns the same key when only flag order differs", () => {
    const a = computeKey({
      cli: "x", argv: ["go", "--a", "1", "--b", "2"], stdin: "",
      env: {}, envWhitelist: [], normalizeArgs: "flag-order-insensitive",
    });
    const b = computeKey({
      cli: "x", argv: ["go", "--b", "2", "--a", "1"], stdin: "",
      env: {}, envWhitelist: [], normalizeArgs: "flag-order-insensitive",
    });
    expect(a.hash).toBe(b.hash);
  });

  it("returns different keys when stdin differs", () => {
    const a = computeKey({
      cli: "x", argv: ["go"], stdin: "{}",
      env: {}, envWhitelist: [], normalizeArgs: "flag-order-insensitive",
    });
    const b = computeKey({
      cli: "x", argv: ["go"], stdin: '{"a":1}',
      env: {}, envWhitelist: [], normalizeArgs: "flag-order-insensitive",
    });
    expect(a.hash).not.toBe(b.hash);
  });

  it("ignores env vars not in whitelist", () => {
    const a = computeKey({
      cli: "x", argv: ["go"], stdin: "",
      env: { PATH: "/a", SLACK_BOT_TOKEN: "x" }, envWhitelist: ["SLACK_BOT_TOKEN"],
      normalizeArgs: "flag-order-insensitive",
    });
    const b = computeKey({
      cli: "x", argv: ["go"], stdin: "",
      env: { PATH: "/b", SLACK_BOT_TOKEN: "x" }, envWhitelist: ["SLACK_BOT_TOKEN"],
      normalizeArgs: "flag-order-insensitive",
    });
    expect(a.hash).toBe(b.hash);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run eval-mocks/test/key.test.ts
```

Expected: FAIL — module not found `../src/key.js`.

- [ ] **Step 3: Implement `key.ts`**

Create `eval-mocks/src/key.ts`:

```typescript
import { createHash } from "node:crypto";
import type { FixtureKey } from "./types.js";

export type ArgNormalization = "flag-order-insensitive" | "preserve-order";

/**
 * Normalize argv so that semantically-equivalent invocations produce the
 * same key. In flag-order-insensitive mode, pairs of (--flag, value) are
 * sorted alphabetically by flag name; positional args keep their order.
 *
 * `--flag=value` is canonicalized to ["--flag", "value"] before sorting.
 * Boolean flags (--flag with no following value or with a following flag)
 * are sorted as standalone tokens.
 *
 * Repeated flags (--include a --include b) keep their relative order
 * within the repetition group, which matters when the CLI treats order
 * as semantically meaningful.
 */
export function normalizeArgv(argv: string[], mode: ArgNormalization): string[] {
  if (mode === "preserve-order") return [...argv];

  // Step 1: split = forms (--flag=val → --flag val)
  const expanded: string[] = [];
  for (const tok of argv) {
    const eq = tok.indexOf("=");
    if (tok.startsWith("--") && eq > 2) {
      expanded.push(tok.slice(0, eq), tok.slice(eq + 1));
    } else {
      expanded.push(tok);
    }
  }

  // Step 2: walk tokens. Positionals stay in order; flag pairs are
  // collected, then sorted, then re-emitted after the positionals.
  const positionals: string[] = [];
  type Pair = { flag: string; value: string | null; order: number };
  const pairs: Pair[] = [];
  let order = 0;
  for (let i = 0; i < expanded.length; i++) {
    const tok = expanded[i];
    if (tok.startsWith("--")) {
      const next = expanded[i + 1];
      if (next === undefined || next.startsWith("--")) {
        pairs.push({ flag: tok, value: null, order: order++ });
      } else {
        pairs.push({ flag: tok, value: next, order: order++ });
        i++;
      }
    } else {
      positionals.push(tok);
    }
  }

  // Stable sort by flag name; preserve original order within same flag
  // (handles --include a --include b correctly).
  pairs.sort((a, b) => {
    if (a.flag !== b.flag) return a.flag < b.flag ? -1 : 1;
    return a.order - b.order;
  });

  const out = [...positionals];
  for (const p of pairs) {
    out.push(p.flag);
    if (p.value !== null) out.push(p.value);
  }
  return out;
}

const SLUG_UNSAFE = /[^a-zA-Z0-9._-]/g;

/**
 * Build a filesystem-safe slug from the first ~5 argv tokens. Aim is
 * human readability when browsing the cassette dir; uniqueness is
 * provided by the hash.
 */
export function slugify(argv: string[]): string {
  return argv
    .slice(0, 5)
    .map((a) => a.replace(SLUG_UNSAFE, ""))
    .filter((a) => a.length > 0)
    .join("-");
}

/**
 * Compute the cassette key for a CLI invocation. The hash includes
 * normalized argv, stdin, and env vars from the CLI's whitelist. The
 * slug is human-readable; the hash disambiguates collisions.
 */
export function computeKey(opts: {
  cli: string;
  argv: string[];
  stdin: string;
  env: Record<string, string>;
  envWhitelist: string[];
  normalizeArgs: ArgNormalization;
}): FixtureKey {
  const normArgv = normalizeArgv(opts.argv, opts.normalizeArgs);
  const envSubset: Record<string, string> = {};
  for (const k of opts.envWhitelist.slice().sort()) {
    if (opts.env[k] !== undefined) envSubset[k] = opts.env[k];
  }
  const payload = JSON.stringify({
    cli: opts.cli,
    argv: normArgv,
    stdin: opts.stdin,
    env: envSubset,
  });
  const hash = createHash("sha256").update(payload).digest("hex").slice(0, 8);
  return { cli: opts.cli, slug: slugify(normArgv), hash };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run eval-mocks/test/key.test.ts
```

Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add eval-mocks/src/key.ts eval-mocks/test/key.test.ts
git commit -m "feat(eval): add key computation, argv normalization, slug

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Anonymizer rule loader

**Files:**
- Create: `clis-worker/eval-mocks/src/anonymizer-rules.ts`
- Create: `clis-worker/eval-mocks/test/anonymizer-rules.test.ts`
- Create: `clis-worker/eval-fixtures/.anonymize/global.yaml`
- Create: `clis-worker/eval-fixtures/.anonymize/slack-pp-cli.yaml`
- Create: `clis-worker/eval-fixtures/.anonymize/scrape-creators-pp-cli.yaml`
- Create: `clis-worker/eval-fixtures/.anonymize/contentful-pp-cli.yaml`
- Create: `clis-worker/eval-fixtures/.anonymize/ga4-pp-cli.yaml`
- Create: `clis-worker/eval-fixtures/.anonymize/screaming-frog-pp-cli.yaml`

- [ ] **Step 1: Author the YAML rule files**

Create `eval-fixtures/.anonymize/global.yaml`:

```yaml
# Global anonymization rules. Apply to every CLI's output before per-CLI
# rules. Pattern rules scan strings; field_names rules scrub JSON values
# whose key (case-insensitive) matches.

patterns:
  - name: email
    regex: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
    strategy: hash
    prefix: email_
  - name: e164-phone
    regex: '\+[1-9]\d{6,14}'
    strategy: hash
    prefix: phone_

field_names:
  - email
  - email_address
  - phone
  - phone_number
  - display_name
  - real_name
  - first_name
  - last_name
  - full_name
```

Create `eval-fixtures/.anonymize/slack-pp-cli.yaml`:

```yaml
# Per-CLI overrides for slack-pp-cli. Augments global rules.
# JSONPath subset supported: $.foo, $.foo.bar, $.foo[*].bar, $..bar
# (recursive descent). Other JSONPath features intentionally out of scope.

fields:
  - jsonpath: '$..channel.name'
    strategy: hash
    prefix: channel_
  - jsonpath: '$..user.id'
    strategy: hash
    prefix: user_
  - jsonpath: '$..team.domain'
    strategy: hash
    prefix: team_

env_whitelist:
  - SLACK_BOT_TOKEN
arg_normalization: flag-order-insensitive
prose_doctor: true
```

Create `eval-fixtures/.anonymize/scrape-creators-pp-cli.yaml`:

```yaml
fields:
  - jsonpath: '$..author.handle'
    strategy: hash
    prefix: handle_
  - jsonpath: '$..creator.handle'
    strategy: hash
    prefix: handle_
  - jsonpath: '$..url'
    strategy: hash
    prefix: url_

env_whitelist:
  - SCRAPECREATORS_API_KEY
arg_normalization: flag-order-insensitive
prose_doctor: true
```

Create `eval-fixtures/.anonymize/contentful-pp-cli.yaml`:

```yaml
fields:
  - jsonpath: '$..sys.id'
    strategy: hash
    prefix: entry_
  - jsonpath: '$..fields.title'
    strategy: hash
    prefix: title_

env_whitelist:
  - CONTENTFUL_SPACE_ID
  - CONTENTFUL_DELIVERY_TOKEN
  - CONTENTFUL_MANAGEMENT_TOKEN
arg_normalization: flag-order-insensitive
prose_doctor: true
```

Create `eval-fixtures/.anonymize/ga4-pp-cli.yaml`:

```yaml
fields:
  - jsonpath: '$..pagePath'
    strategy: hash
    prefix: path_
  - jsonpath: '$..hostName'
    strategy: hash
    prefix: host_

env_whitelist:
  - GA4_PROPERTY_ID
  - GOOGLE_APPLICATION_CREDENTIALS
arg_normalization: flag-order-insensitive
prose_doctor: true
```

Create `eval-fixtures/.anonymize/screaming-frog-pp-cli.yaml`:

```yaml
fields:
  - jsonpath: '$..url'
    strategy: hash
    prefix: url_

env_whitelist:
  - PRESS_DATA_DIR
arg_normalization: flag-order-insensitive
prose_doctor: true
```

- [ ] **Step 2: Write the failing loader tests**

Create `eval-mocks/test/anonymizer-rules.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRules } from "../src/anonymizer-rules.js";

function tmpRulesDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "eval-rules-"));
  const anon = path.join(dir, ".anonymize");
  mkdirSync(anon);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(anon, name), content);
  }
  return dir;
}

describe("loadRules", () => {
  it("loads global rules from global.yaml", () => {
    const dir = tmpRulesDir({
      "global.yaml": `
patterns:
  - { name: email, regex: '\\S+@\\S+', strategy: hash, prefix: email_ }
field_names: [email, phone]
`,
    });
    const rules = loadRules(dir);
    expect(rules.global.patterns).toHaveLength(1);
    expect(rules.global.patterns[0].name).toBe("email");
    expect(rules.global.field_names).toEqual(["email", "phone"]);
    expect(rules.per_cli).toEqual({});
  });

  it("loads per-CLI rules from <cli>.yaml", () => {
    const dir = tmpRulesDir({
      "global.yaml": `patterns: []
field_names: []`,
      "slack-pp-cli.yaml": `
fields:
  - { jsonpath: '$..channel.name', strategy: hash, prefix: channel_ }
env_whitelist: [SLACK_BOT_TOKEN]
arg_normalization: flag-order-insensitive
prose_doctor: true
`,
    });
    const rules = loadRules(dir);
    expect(rules.per_cli["slack-pp-cli"]).toBeDefined();
    expect(rules.per_cli["slack-pp-cli"].fields).toHaveLength(1);
    expect(rules.per_cli["slack-pp-cli"].env_whitelist).toEqual(["SLACK_BOT_TOKEN"]);
    expect(rules.per_cli["slack-pp-cli"].arg_normalization).toBe("flag-order-insensitive");
    expect(rules.per_cli["slack-pp-cli"].prose_doctor).toBe(true);
  });

  it("provides safe defaults when global.yaml is missing", () => {
    const dir = tmpRulesDir({});
    const rules = loadRules(dir);
    expect(rules.global.patterns).toEqual([]);
    expect(rules.global.field_names).toEqual([]);
    expect(rules.per_cli).toEqual({});
  });

  it("returns default CliRules when querying an unknown CLI", () => {
    const dir = tmpRulesDir({});
    const rules = loadRules(dir);
    const r = rules.per_cli["unknown-cli"];
    expect(r).toBeUndefined(); // caller falls back to default
  });

  it("ignores files that aren't .yaml", () => {
    const dir = tmpRulesDir({
      "README.md": "# notes",
      "global.yaml": "patterns: []\nfield_names: []",
    });
    expect(() => loadRules(dir)).not.toThrow();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx vitest run eval-mocks/test/anonymizer-rules.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `anonymizer-rules.ts`**

Create `eval-mocks/src/anonymizer-rules.ts`:

```typescript
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { AnonymizerRules, CliRules, GlobalRules } from "./types.js";

const DEFAULT_GLOBAL: GlobalRules = {
  patterns: [],
  field_names: [],
};

export const DEFAULT_CLI_RULES: CliRules = {
  fields: [],
  env_whitelist: [],
  arg_normalization: "flag-order-insensitive",
  prose_doctor: false,
};

/**
 * Load anonymization rules from <fixtureDir>/.anonymize/. global.yaml is
 * optional (defaults to empty rules); each per-CLI file <cli-name>.yaml
 * defines that CLI's overrides. Files without a .yaml extension are
 * silently ignored.
 */
export function loadRules(fixtureDir: string): AnonymizerRules {
  const dir = path.join(fixtureDir, ".anonymize");
  if (!existsSync(dir)) {
    return { global: { ...DEFAULT_GLOBAL }, per_cli: {} };
  }

  const globalPath = path.join(dir, "global.yaml");
  let global: GlobalRules = { ...DEFAULT_GLOBAL };
  if (existsSync(globalPath)) {
    const parsed = yaml.load(readFileSync(globalPath, "utf8")) as Partial<GlobalRules> | null;
    if (parsed) {
      global = {
        patterns: parsed.patterns ?? [],
        field_names: parsed.field_names ?? [],
      };
    }
  }

  const per_cli: Record<string, CliRules> = {};
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".yaml") || entry === "global.yaml") continue;
    const cli = entry.replace(/\.yaml$/, "");
    const parsed = yaml.load(readFileSync(path.join(dir, entry), "utf8")) as Partial<CliRules> | null;
    if (!parsed) continue;
    per_cli[cli] = {
      fields: parsed.fields ?? [],
      env_whitelist: parsed.env_whitelist ?? [],
      arg_normalization: parsed.arg_normalization ?? "flag-order-insensitive",
      prose_doctor: parsed.prose_doctor ?? false,
    };
  }

  return { global, per_cli };
}

export function getCliRules(rules: AnonymizerRules, cli: string): CliRules {
  return rules.per_cli[cli] ?? DEFAULT_CLI_RULES;
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run eval-mocks/test/anonymizer-rules.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add eval-mocks/src/anonymizer-rules.ts eval-mocks/test/anonymizer-rules.test.ts \
        eval-fixtures/.anonymize/
git commit -m "feat(eval): add anonymization rule loader + initial YAML rules

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Anonymizer pattern application (string-level)

**Files:**
- Create: `clis-worker/eval-mocks/src/anonymizer-patterns.ts`
- Create: `clis-worker/eval-mocks/test/anonymizer-patterns.test.ts`

- [ ] **Step 1: Write the failing test**

Create `eval-mocks/test/anonymizer-patterns.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { applyPatterns, hashReplacement } from "../src/anonymizer-patterns.js";

describe("hashReplacement", () => {
  it("is deterministic for the same input", () => {
    expect(hashReplacement("alice@example.com", "email_"))
      .toBe(hashReplacement("alice@example.com", "email_"));
  });

  it("differs between values", () => {
    expect(hashReplacement("alice@example.com", "email_"))
      .not.toBe(hashReplacement("bob@example.com", "email_"));
  });

  it("preserves the prefix", () => {
    expect(hashReplacement("x", "user_")).toMatch(/^user_[0-9a-f]{8}$/);
  });
});

describe("applyPatterns", () => {
  const patterns = [
    {
      name: "email",
      regex: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",
      strategy: "hash" as const,
      prefix: "email_",
    },
  ];

  it("replaces all matches in a string", () => {
    const r = applyPatterns("contact alice@example.com or bob@x.io", patterns);
    expect(r.text).not.toContain("alice@example.com");
    expect(r.text).not.toContain("bob@x.io");
    expect(r.text).toMatch(/email_[0-9a-f]{8}/g);
    expect(r.redactions).toHaveLength(2);
  });

  it("uses the same replacement for the same value (reference integrity)", () => {
    const r = applyPatterns("alice@x.io and again alice@x.io", patterns);
    const matches = r.text.match(/email_[0-9a-f]{8}/g)!;
    expect(matches[0]).toBe(matches[1]);
  });

  it("returns the original text and no redactions when no patterns match", () => {
    const r = applyPatterns("hello world", patterns);
    expect(r.text).toBe("hello world");
    expect(r.redactions).toEqual([]);
  });

  it("records each replacement in the audit", () => {
    const r = applyPatterns("a@b.io", patterns);
    expect(r.redactions[0].rule).toBe("global:email");
    expect(r.redactions[0].replacement).toMatch(/^email_[0-9a-f]{8}$/);
    expect(r.redactions[0].original_hash).toMatch(/^[0-9a-f]{8}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run eval-mocks/test/anonymizer-patterns.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `anonymizer-patterns.ts`**

Create `eval-mocks/src/anonymizer-patterns.ts`:

```typescript
import { createHash } from "node:crypto";
import type { AuditEntry, GlobalRules } from "./types.js";

/**
 * Stable hash → human prefix replacement. Same `value` always produces
 * the same replacement, which gives us reference integrity across all
 * cassettes for free (no shared identity-map needed).
 */
export function hashReplacement(value: string, prefix: string): string {
  const h = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${prefix}${h}`;
}

/**
 * Hash of just the original value, used in audit entries to verify
 * (post-hoc) which fake corresponds to which real value during review.
 * Storing the full original would defeat the anonymization.
 */
function originalHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * Walk a string, applying every pattern's regex. Each match is replaced
 * with hash or redacted (literal "[redacted]"). Order: patterns applied
 * sequentially; inside a single pattern, all matches replaced.
 *
 * Returns the modified text and one AuditEntry per replacement made.
 */
export function applyPatterns(
  text: string,
  patterns: GlobalRules["patterns"],
): { text: string; redactions: AuditEntry[] } {
  let out = text;
  const redactions: AuditEntry[] = [];

  for (const p of patterns) {
    const re = new RegExp(p.regex, "g");
    out = out.replace(re, (match) => {
      const replacement = p.strategy === "redact"
        ? "[redacted]"
        : hashReplacement(match, p.prefix);
      redactions.push({
        jsonpath: "(string-pattern)",
        rule: `global:${p.name}`,
        original_hash: originalHash(match),
        replacement,
      });
      return replacement;
    });
  }

  return { text: out, redactions };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run eval-mocks/test/anonymizer-patterns.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add eval-mocks/src/anonymizer-patterns.ts eval-mocks/test/anonymizer-patterns.test.ts
git commit -m "feat(eval): add string-level pattern anonymization

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Anonymizer JSON walker + per-CLI field rules + orchestration

**Files:**
- Create: `clis-worker/eval-mocks/src/anonymizer.ts`
- Create: `clis-worker/eval-mocks/test/anonymizer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `eval-mocks/test/anonymizer.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { anonymize } from "../src/anonymizer.js";
import type { AnonymizerRules } from "../src/types.js";

const rules: AnonymizerRules = {
  global: {
    patterns: [
      { name: "email", regex: "\\S+@\\S+\\.\\S+", strategy: "hash", prefix: "email_" },
    ],
    field_names: ["display_name"],
  },
  per_cli: {
    "slack-pp-cli": {
      fields: [
        { jsonpath: "$..channel.name", strategy: "hash", prefix: "channel_" },
        { jsonpath: "$..user.id", strategy: "hash", prefix: "user_" },
      ],
      env_whitelist: ["SLACK_BOT_TOKEN"],
      arg_normalization: "flag-order-insensitive",
      prose_doctor: true,
    },
  },
};

describe("anonymize (JSON path)", () => {
  it("scrubs nested fields by jsonpath", () => {
    const out = anonymize({
      cli: "slack-pp-cli",
      output: JSON.stringify({ channels: [{ channel: { name: "general" } }] }),
      rules,
      isJson: true,
    });
    const parsed = JSON.parse(out.output);
    expect(parsed.channels[0].channel.name).toMatch(/^channel_[0-9a-f]{8}$/);
    expect(out.redactions).toHaveLength(1);
    expect(out.redactions[0].rule).toBe("cli:slack-pp-cli:$..channel.name");
  });

  it("preserves reference integrity across multiple paths", () => {
    const out = anonymize({
      cli: "slack-pp-cli",
      output: JSON.stringify({
        users: [
          { user: { id: "U001" }, history: { user: { id: "U001" } } },
          { user: { id: "U002" } },
        ],
      }),
      rules,
      isJson: true,
    });
    const parsed = JSON.parse(out.output);
    expect(parsed.users[0].user.id).toBe(parsed.users[0].history.user.id);
    expect(parsed.users[0].user.id).not.toBe(parsed.users[1].user.id);
  });

  it("scrubs by global field_names list", () => {
    const out = anonymize({
      cli: "slack-pp-cli",
      output: JSON.stringify({ display_name: "Alex Smith", other: "kept" }),
      rules,
      isJson: true,
    });
    const parsed = JSON.parse(out.output);
    expect(parsed.display_name).not.toBe("Alex Smith");
    expect(parsed.other).toBe("kept");
  });

  it("applies global patterns to string values within JSON", () => {
    const out = anonymize({
      cli: "slack-pp-cli",
      output: JSON.stringify({ contact: "Email alice@example.com for help" }),
      rules,
      isJson: true,
    });
    const parsed = JSON.parse(out.output);
    expect(parsed.contact).toMatch(/email_[0-9a-f]{8}/);
    expect(parsed.contact).not.toContain("alice@example.com");
  });

  it("preserves shape: types, null, missing, empty arrays", () => {
    const out = anonymize({
      cli: "slack-pp-cli",
      output: JSON.stringify({
        a: null,
        b: 42,
        c: true,
        d: [],
        e: {},
        nested: { f: null },
      }),
      rules,
      isJson: true,
    });
    expect(JSON.parse(out.output)).toEqual({
      a: null, b: 42, c: true, d: [], e: {}, nested: { f: null },
    });
  });

  it("falls back to pattern-only scan for non-JSON output", () => {
    const out = anonymize({
      cli: "slack-pp-cli",
      output: "auth ok for alice@example.com",
      rules,
      isJson: false,
    });
    expect(out.output).not.toContain("alice@example.com");
    expect(out.notes).toContain("non-JSON: pattern scan only");
  });

  it("handles unknown CLI by skipping per-CLI rules", () => {
    const out = anonymize({
      cli: "unknown-cli",
      output: JSON.stringify({ display_name: "Alex" }),
      rules,
      isJson: true,
    });
    const parsed = JSON.parse(out.output);
    expect(parsed.display_name).not.toBe("Alex"); // global field_names still applies
  });

  it("is idempotent: anonymizing an already-anonymized output is a no-op", () => {
    const first = anonymize({
      cli: "slack-pp-cli",
      output: JSON.stringify({ channel: { name: "general" } }),
      rules,
      isJson: true,
    });
    const second = anonymize({
      cli: "slack-pp-cli",
      output: first.output,
      rules,
      isJson: true,
    });
    expect(second.output).toBe(first.output);
    expect(second.redactions).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run eval-mocks/test/anonymizer.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `anonymizer.ts`**

Create `eval-mocks/src/anonymizer.ts`:

```typescript
import type {
  AnonymizerRules,
  AnonymizeResult,
  AuditEntry,
  CliRules,
} from "./types.js";
import { applyPatterns, hashReplacement } from "./anonymizer-patterns.js";
import { getCliRules } from "./anonymizer-rules.js";
import { createHash } from "node:crypto";

const ANON_MARKER_RE = /^[a-z]+_[0-9a-f]{8}$/;

function originalHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * Tiny JSONPath subset used by per-CLI rules:
 *   $.foo           — top-level "foo"
 *   $.foo.bar       — chained
 *   $.foo[*].bar    — array-element step
 *   $..bar          — recursive descent finding any "bar"
 *
 * Anything more exotic is intentionally not supported; rules can be
 * decomposed into multiple paths instead.
 */
type Step =
  | { kind: "key"; name: string }
  | { kind: "any-array" }
  | { kind: "descend"; name: string };

function parsePath(path: string): Step[] {
  if (!path.startsWith("$")) {
    throw new Error(`anonymizer: jsonpath must start with $: ${path}`);
  }
  const rest = path.slice(1);
  const steps: Step[] = [];
  let i = 0;
  while (i < rest.length) {
    const c = rest[i];
    if (c === ".") {
      if (rest[i + 1] === ".") {
        // recursive descent: ..name
        const m = rest.slice(i + 2).match(/^([A-Za-z0-9_]+)/);
        if (!m) throw new Error(`anonymizer: bad descent in ${path}`);
        steps.push({ kind: "descend", name: m[1] });
        i += 2 + m[1].length;
      } else {
        const m = rest.slice(i + 1).match(/^([A-Za-z0-9_]+)/);
        if (!m) throw new Error(`anonymizer: bad key in ${path}`);
        steps.push({ kind: "key", name: m[1] });
        i += 1 + m[1].length;
      }
    } else if (c === "[" && rest[i + 1] === "*" && rest[i + 2] === "]") {
      steps.push({ kind: "any-array" });
      i += 3;
    } else {
      throw new Error(`anonymizer: unsupported jsonpath construct at ${i} in ${path}`);
    }
  }
  return steps;
}

/**
 * Walk steps over `obj`, calling `visit` with (parent, key) for every
 * value the path resolves to. parent[key] is mutable so visitors can
 * replace in place.
 */
function walk(
  obj: unknown,
  steps: Step[],
  visit: (parent: any, key: string | number) => void,
): void {
  if (steps.length === 0) return;
  const [step, ...rest] = steps;

  const recurse = (node: unknown) => {
    if (node === null || typeof node !== "object") return;
    walk(node, rest, visit);
  };

  if (step.kind === "key") {
    if (obj && typeof obj === "object" && !Array.isArray(obj) && step.name in (obj as object)) {
      if (rest.length === 0) {
        visit(obj as any, step.name);
      } else {
        recurse((obj as any)[step.name]);
      }
    }
  } else if (step.kind === "any-array") {
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        if (rest.length === 0) visit(obj as any, i);
        else recurse((obj as any)[i]);
      }
    }
  } else if (step.kind === "descend") {
    // Find any occurrence of step.name anywhere in the tree.
    const stack: unknown[] = [obj];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === null || typeof cur !== "object") continue;
      if (Array.isArray(cur)) {
        for (const v of cur) stack.push(v);
        continue;
      }
      const o = cur as Record<string, unknown>;
      for (const k of Object.keys(o)) {
        if (k === step.name) {
          if (rest.length === 0) visit(o, k);
          else walk(o[k], rest, visit);
        }
        stack.push(o[k]);
      }
    }
  }
}

/**
 * Apply per-CLI field rules and global field_names to a parsed JSON tree.
 * Mutates `obj` in place; returns the audit entries.
 */
function applyJsonRules(
  obj: any,
  cli: string,
  rules: AnonymizerRules,
): AuditEntry[] {
  const cliRules = getCliRules(rules, cli);
  const audit: AuditEntry[] = [];

  // Per-CLI jsonpath rules
  for (const field of cliRules.fields) {
    const steps = parsePath(field.jsonpath);
    walk(obj, steps, (parent, key) => {
      const value = parent[key];
      if (typeof value !== "string") return;
      if (ANON_MARKER_RE.test(value)) return; // already anonymized
      const replacement = field.strategy === "redact"
        ? "[redacted]"
        : hashReplacement(value, field.prefix ?? "val_");
      parent[key] = replacement;
      audit.push({
        jsonpath: field.jsonpath,
        rule: `cli:${cli}:${field.jsonpath}`,
        original_hash: originalHash(value),
        replacement,
      });
    });
  }

  // Global field_names: walk every key of every object
  const globalNames = new Set(rules.global.field_names.map((n) => n.toLowerCase()));
  if (globalNames.size > 0) {
    const stack: { node: any; jp: string }[] = [{ node: obj, jp: "$" }];
    while (stack.length) {
      const { node, jp } = stack.pop()!;
      if (node === null || typeof node !== "object") continue;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          stack.push({ node: node[i], jp: `${jp}[${i}]` });
        }
        continue;
      }
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (globalNames.has(k.toLowerCase()) && typeof v === "string" && !ANON_MARKER_RE.test(v)) {
          const replacement = hashReplacement(v, `${k.toLowerCase()}_`);
          node[k] = replacement;
          audit.push({
            jsonpath: `${jp}.${k}`,
            rule: `global:field:${k}`,
            original_hash: originalHash(v),
            replacement,
          });
        }
        stack.push({ node: v, jp: `${jp}.${k}` });
      }
    }
  }

  return audit;
}

/**
 * Apply global string patterns to every string value in a JSON tree.
 */
function applyJsonPatterns(
  obj: any,
  rules: AnonymizerRules,
): AuditEntry[] {
  const audit: AuditEntry[] = [];
  const stack: { node: any; jp: string }[] = [{ node: obj, jp: "$" }];
  while (stack.length) {
    const { node, jp } = stack.pop()!;
    if (node === null || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const child = node[i];
        if (typeof child === "string") {
          const r = applyPatterns(child, rules.global.patterns);
          if (r.redactions.length > 0) {
            node[i] = r.text;
            audit.push(...r.redactions.map((e) => ({ ...e, jsonpath: `${jp}[${i}]` })));
          }
        } else {
          stack.push({ node: child, jp: `${jp}[${i}]` });
        }
      }
      continue;
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === "string") {
        const r = applyPatterns(v, rules.global.patterns);
        if (r.redactions.length > 0) {
          node[k] = r.text;
          audit.push(...r.redactions.map((e) => ({ ...e, jsonpath: `${jp}.${k}` })));
        }
      } else {
        stack.push({ node: v, jp: `${jp}.${k}` });
      }
    }
  }
  return audit;
}

export function anonymize(opts: {
  cli: string;
  output: string;
  rules: AnonymizerRules;
  isJson: boolean;
}): AnonymizeResult {
  const notes: string[] = [];

  if (!opts.isJson) {
    const r = applyPatterns(opts.output, opts.rules.global.patterns);
    notes.push("non-JSON: pattern scan only");
    return { output: r.text, redactions: r.redactions, notes };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.output);
  } catch {
    const r = applyPatterns(opts.output, opts.rules.global.patterns);
    notes.push("declared JSON but failed to parse: pattern scan only");
    return { output: r.text, redactions: r.redactions, notes };
  }

  const audit: AuditEntry[] = [];
  audit.push(...applyJsonRules(parsed, opts.cli, opts.rules));
  audit.push(...applyJsonPatterns(parsed, opts.rules));

  return {
    output: JSON.stringify(parsed),
    redactions: audit,
    notes,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run eval-mocks/test/anonymizer.test.ts
```

Expected: PASS — all anonymizer tests green.

- [ ] **Step 5: Commit**

```bash
git add eval-mocks/src/anonymizer.ts eval-mocks/test/anonymizer.test.ts
git commit -m "feat(eval): add JSON-path anonymizer with reference integrity

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Cassette store (read/write/audit/INDEX)

**Files:**
- Create: `clis-worker/eval-mocks/src/store.ts`
- Create: `clis-worker/eval-mocks/test/store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `eval-mocks/test/store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cassettePath, auditPath, readCassette, writeCassette, regenerateIndex,
} from "../src/store.js";
import type { Cassette, AuditLog } from "../src/types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "eval-store-"));
});

const sampleCassette: Cassette = {
  request: {
    cli: "slack-pp-cli",
    argv: ["channels", "list", "--agent"],
    argv_raw: ["channels", "list", "--agent"],
    stdin: "",
    env_subset: { SLACK_BOT_TOKEN: "xoxb-eval" },
  },
  response: { stdout: '{"ok":true}', stderr: "", exit_code: 0 },
  meta: {
    recorded_at: "2026-05-11T00:00:00Z",
    cli_version: "1.0.0",
    dispatcher_version: "1.0.0",
  },
};

const sampleAudit: AuditLog = {
  cassette: "channels-list--agent__abcd1234.json",
  redactions: [],
  notes: [],
};

describe("cassettePath/auditPath", () => {
  it("composes the right path", () => {
    const p = cassettePath(dir, { cli: "slack-pp-cli", slug: "x", hash: "12345678" });
    expect(p).toBe(path.join(dir, "slack-pp-cli", "x__12345678.json"));
    const a = auditPath(dir, { cli: "slack-pp-cli", slug: "x", hash: "12345678" });
    expect(a).toBe(path.join(dir, "slack-pp-cli", "x__12345678.audit.json"));
  });
});

describe("writeCassette / readCassette", () => {
  it("round-trips a cassette and audit log", () => {
    const key = { cli: "slack-pp-cli", slug: "channels-list--agent", hash: "abcd1234" };
    writeCassette(dir, key, sampleCassette, sampleAudit);
    const r = readCassette(dir, key);
    expect(r).toEqual(sampleCassette);
    const audit = JSON.parse(readFileSync(auditPath(dir, key), "utf8"));
    expect(audit.cassette).toBe(sampleAudit.cassette);
  });

  it("returns null on miss", () => {
    expect(readCassette(dir, { cli: "x", slug: "y", hash: "00000000" })).toBeNull();
  });

  it("creates the CLI subdirectory if missing", () => {
    const key = { cli: "new-cli", slug: "doctor", hash: "11111111" };
    writeCassette(dir, key, sampleCassette, sampleAudit);
    expect(existsSync(path.join(dir, "new-cli"))).toBe(true);
  });

  it("writes atomically (no partial files on simulated crash)", () => {
    const key = { cli: "slack-pp-cli", slug: "x", hash: "atomic01" };
    writeCassette(dir, key, sampleCassette, sampleAudit);
    // No .tmp leftover
    const cliDir = path.join(dir, "slack-pp-cli");
    const files = readdirSync(cliDir);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });
});

describe("regenerateIndex", () => {
  it("emits a markdown table covering every cassette", () => {
    const k1 = { cli: "slack-pp-cli", slug: "channels-list", hash: "11111111" };
    const k2 = { cli: "contentful-pp-cli", slug: "doctor", hash: "22222222" };
    writeCassette(dir, k1, sampleCassette, sampleAudit);
    writeCassette(dir, k2, sampleCassette, sampleAudit);
    regenerateIndex(dir);
    const md = readFileSync(path.join(dir, "INDEX.md"), "utf8");
    expect(md).toContain("slack-pp-cli");
    expect(md).toContain("contentful-pp-cli");
    expect(md).toContain("11111111");
    expect(md).toContain("22222222");
  });

  it("handles an empty fixtures dir without erroring", () => {
    expect(() => regenerateIndex(dir)).not.toThrow();
    const md = readFileSync(path.join(dir, "INDEX.md"), "utf8");
    expect(md).toContain("No cassettes recorded yet");
  });

  it("ignores non-cassette files in the cli subdirs", () => {
    mkdirSync(path.join(dir, "slack-pp-cli"));
    writeFileSync(path.join(dir, "slack-pp-cli", "README.md"), "# notes");
    expect(() => regenerateIndex(dir)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run eval-mocks/test/store.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `store.ts`**

Create `eval-mocks/src/store.ts`:

```typescript
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  readdirSync, statSync, unlinkSync,
} from "node:fs";
import path from "node:path";
import type { AuditLog, Cassette, FixtureKey } from "./types.js";

export function cassettePath(dir: string, key: FixtureKey): string {
  return path.join(dir, key.cli, `${key.slug}__${key.hash}.json`);
}

export function auditPath(dir: string, key: FixtureKey): string {
  return path.join(dir, key.cli, `${key.slug}__${key.hash}.audit.json`);
}

export function readCassette(dir: string, key: FixtureKey): Cassette | null {
  const p = cassettePath(dir, key);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as Cassette;
}

/**
 * Atomic write: writes to <name>.tmp then renames. If the process dies
 * before the rename, a stale .tmp may remain — we delete any pre-existing
 * .tmp at the same target path before writing. The audit file is written
 * after the cassette so a half-written pair leaves only the cassette.
 */
export function writeCassette(
  dir: string,
  key: FixtureKey,
  cassette: Cassette,
  audit: AuditLog,
): void {
  const cliDir = path.join(dir, key.cli);
  if (!existsSync(cliDir)) mkdirSync(cliDir, { recursive: true });

  const cp = cassettePath(dir, key);
  const ap = auditPath(dir, key);
  const cpTmp = `${cp}.tmp`;
  const apTmp = `${ap}.tmp`;

  if (existsSync(cpTmp)) unlinkSync(cpTmp);
  if (existsSync(apTmp)) unlinkSync(apTmp);

  writeFileSync(cpTmp, JSON.stringify(cassette, null, 2));
  renameSync(cpTmp, cp);

  writeFileSync(apTmp, JSON.stringify(audit, null, 2));
  renameSync(apTmp, ap);
}

interface IndexEntry {
  cli: string;
  filename: string;
  hash: string;
  slug: string;
  recorded_at: string;
  cli_version: string;
}

/**
 * Walk every <cli>/ subdirectory of `dir`, collect cassette files
 * (matching the `<slug>__<hash>.json` pattern, excluding .audit.json),
 * and emit INDEX.md grouping by CLI.
 */
export function regenerateIndex(dir: string): void {
  const entries: IndexEntry[] = [];
  if (!existsSync(dir)) {
    writeFileSync(path.join(dir, "INDEX.md"), "# Eval cassettes\n\nNo cassettes recorded yet.\n");
    return;
  }
  const cliDirs = readdirSync(dir).filter((name) => {
    const p = path.join(dir, name);
    return name !== ".anonymize" && !name.startsWith(".") && statSync(p).isDirectory();
  });

  for (const cli of cliDirs) {
    const cliPath = path.join(dir, cli);
    for (const f of readdirSync(cliPath)) {
      if (!f.endsWith(".json") || f.endsWith(".audit.json") || f.endsWith(".tmp")) continue;
      const m = f.match(/^(.+)__([0-9a-f]{8})\.json$/);
      if (!m) continue;
      try {
        const cassette = JSON.parse(readFileSync(path.join(cliPath, f), "utf8")) as Cassette;
        entries.push({
          cli,
          filename: f,
          slug: m[1],
          hash: m[2],
          recorded_at: cassette.meta.recorded_at,
          cli_version: cassette.meta.cli_version,
        });
      } catch {
        // skip unparseable
      }
    }
  }

  let md = "# Eval cassettes\n\n";
  if (entries.length === 0) {
    md += "No cassettes recorded yet.\n";
  } else {
    md += `${entries.length} cassettes across ${new Set(entries.map((e) => e.cli)).size} CLIs.\n\n`;
    md += "| CLI | Slug | Hash | Recorded | CLI version |\n";
    md += "|---|---|---|---|---|\n";
    entries.sort((a, b) => a.cli.localeCompare(b.cli) || a.slug.localeCompare(b.slug));
    for (const e of entries) {
      md += `| ${e.cli} | ${e.slug} | \`${e.hash}\` | ${e.recorded_at} | ${e.cli_version} |\n`;
    }
  }
  writeFileSync(path.join(dir, "INDEX.md"), md);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run eval-mocks/test/store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add eval-mocks/src/store.ts eval-mocks/test/store.test.ts
git commit -m "feat(eval): add cassette store with atomic writes and INDEX.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Dispatcher core — replay path

**Files:**
- Create: `clis-worker/eval-mocks/src/dispatcher.ts`
- Create: `clis-worker/eval-mocks/test/dispatcher-replay.test.ts`

- [ ] **Step 1: Write the failing test**

Create `eval-mocks/test/dispatcher-replay.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dispatch, EXIT_MOCK_MISS } from "../src/dispatcher.js";
import { writeCassette } from "../src/store.js";
import type { Cassette, AuditLog } from "../src/types.js";

let fixtureDir: string;

beforeEach(() => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), "eval-dispatcher-"));
  mkdirSync(path.join(fixtureDir, ".anonymize"));
});

const cass = (stdout: string, exit = 0): Cassette => ({
  request: {
    cli: "fake-pp-cli",
    argv: ["doctor", "--agent"],
    argv_raw: ["doctor", "--agent"],
    stdin: "",
    env_subset: {},
  },
  response: { stdout, stderr: "", exit_code: exit },
  meta: {
    recorded_at: "2026-05-11T00:00:00Z",
    cli_version: "0.0.0",
    dispatcher_version: "1.0.0",
  },
});

const emptyAudit: AuditLog = { cassette: "x", redactions: [], notes: [] };

describe("dispatch (replay mode)", () => {
  it("returns recorded stdout and exit code for a hit", async () => {
    // Pre-seed a cassette that matches what the dispatcher will compute
    // for argv=['doctor','--agent']
    const stdoutCapture: string[] = [];
    const stderrCapture: string[] = [];

    // Write cassette under the key that will be computed
    const { computeKey } = await import("../src/key.js");
    const key = computeKey({
      cli: "fake-pp-cli",
      argv: ["doctor", "--agent"],
      stdin: "",
      env: {},
      envWhitelist: [],
      normalizeArgs: "flag-order-insensitive",
    });
    writeCassette(fixtureDir, key, cass('{"ok":true}'), emptyAudit);

    const code = await dispatch({
      cli: "fake-pp-cli",
      argv: ["doctor", "--agent"],
      stdin: "",
      env: { EVAL_MOCK_MODE: "replay", EVAL_FIXTURE_DIR: fixtureDir },
      stdout: { write: (s) => { stdoutCapture.push(s); return true; } } as any,
      stderr: { write: (s) => { stderrCapture.push(s); return true; } } as any,
    });

    expect(code).toBe(0);
    expect(stdoutCapture.join("")).toBe('{"ok":true}');
    expect(stderrCapture.join("")).toBe("");
  });

  it("propagates non-zero exit codes from cassettes", async () => {
    const { computeKey } = await import("../src/key.js");
    const key = computeKey({
      cli: "fake-pp-cli",
      argv: ["doctor"],
      stdin: "",
      env: {},
      envWhitelist: [],
      normalizeArgs: "flag-order-insensitive",
    });
    writeCassette(fixtureDir, key, cass("error", 3), emptyAudit);

    const code = await dispatch({
      cli: "fake-pp-cli",
      argv: ["doctor"],
      stdin: "",
      env: { EVAL_MOCK_MODE: "replay", EVAL_FIXTURE_DIR: fixtureDir },
      stdout: { write: () => true } as any,
      stderr: { write: () => true } as any,
    });

    expect(code).toBe(3);
  });

  it("returns EXIT_MOCK_MISS with EVAL_MOCK_MISS in stderr on miss", async () => {
    const stderrCapture: string[] = [];
    const code = await dispatch({
      cli: "fake-pp-cli",
      argv: ["doctor", "--agent"],
      stdin: "",
      env: { EVAL_MOCK_MODE: "replay", EVAL_FIXTURE_DIR: fixtureDir },
      stdout: { write: () => true } as any,
      stderr: { write: (s) => { stderrCapture.push(s); return true; } } as any,
    });

    expect(code).toBe(EXIT_MOCK_MISS);
    expect(EXIT_MOCK_MISS).toBe(87);
    expect(stderrCapture.join("")).toContain("EVAL_MOCK_MISS");
    expect(stderrCapture.join("")).toContain("fake-pp-cli");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run eval-mocks/test/dispatcher-replay.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `dispatcher.ts` (replay only for now; record path stubbed)**

Create `eval-mocks/src/dispatcher.ts`:

```typescript
import type { MockMode } from "./types.js";
import { computeKey } from "./key.js";
import { readCassette } from "./store.js";
import { loadRules, getCliRules } from "./anonymizer-rules.js";

export const EXIT_MOCK_MISS = 87;

export interface DispatchOptions {
  cli: string;
  argv: string[];
  stdin: string;
  env: Record<string, string | undefined>;
  stdout: { write: (s: string) => boolean };
  stderr: { write: (s: string) => boolean };
}

function getMode(env: Record<string, string | undefined>): MockMode {
  const m = (env.EVAL_MOCK_MODE ?? "replay").toLowerCase();
  if (m === "replay" || m === "record" || m === "record-missing") return m;
  throw new Error(`EVAL_MOCK_MODE must be replay|record|record-missing, got: ${m}`);
}

export async function dispatch(opts: DispatchOptions): Promise<number> {
  const mode = getMode(opts.env);
  const fixtureDir = opts.env.EVAL_FIXTURE_DIR;
  if (!fixtureDir) {
    opts.stderr.write("EVAL_FIXTURE_DIR is required\n");
    return 2;
  }

  const rules = loadRules(fixtureDir);
  const cliRules = getCliRules(rules, opts.cli);

  // Build canonical env subset for keying
  const envForKey: Record<string, string> = {};
  for (const k of cliRules.env_whitelist) {
    if (opts.env[k] !== undefined) envForKey[k] = opts.env[k] as string;
  }

  const key = computeKey({
    cli: opts.cli,
    argv: opts.argv,
    stdin: opts.stdin,
    env: envForKey,
    envWhitelist: cliRules.env_whitelist,
    normalizeArgs: cliRules.arg_normalization,
  });

  // Replay: try cassette first
  const cassette = readCassette(fixtureDir, key);
  if (cassette) {
    if (cassette.response.stdout) opts.stdout.write(cassette.response.stdout);
    if (cassette.response.stderr) opts.stderr.write(cassette.response.stderr);
    return cassette.response.exit_code;
  }

  if (mode === "replay") {
    const expected = `${fixtureDir}/${key.cli}/${key.slug}__${key.hash}.json`;
    opts.stderr.write(
      `EVAL_MOCK_MISS ${opts.cli} ${key.slug}\n` +
      `  expected fixture: ${expected}\n` +
      `  re-record with: EVAL_MOCK_MODE=record-missing npm run local-eval\n`,
    );
    return EXIT_MOCK_MISS;
  }

  // record / record-missing — implemented in Task 9
  opts.stderr.write(
    `eval-dispatcher: record path not yet implemented (mode=${mode})\n`,
  );
  return 70;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run eval-mocks/test/dispatcher-replay.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add eval-mocks/src/dispatcher.ts eval-mocks/test/dispatcher-replay.test.ts
git commit -m "feat(eval): add dispatcher replay mode + EVAL_MOCK_MISS handling

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Dispatcher record path

**Files:**
- Modify: `clis-worker/eval-mocks/src/dispatcher.ts`
- Create: `clis-worker/eval-mocks/test/dispatcher-record.test.ts`
- Create: `clis-worker/eval-mocks/test/fixtures/fake-pp-cli`

- [ ] **Step 1: Create the fake CLI used in tests**

Create `eval-mocks/test/fixtures/fake-pp-cli`:

```bash
#!/usr/bin/env bash
# Fake CLI used for integration tests. Returns canned JSON or version.
set -e
case "$1" in
  --version)
    echo "fake-pp-cli 0.1.0"
    ;;
  json)
    echo '{"users":[{"id":"U001","email":"alice@example.com"}]}'
    ;;
  prose)
    echo "auth ok for alice@example.com"
    ;;
  fail)
    echo "boom" >&2
    exit 5
    ;;
  *)
    echo "unknown subcommand: $1" >&2
    exit 2
    ;;
esac
```

```bash
chmod +x eval-mocks/test/fixtures/fake-pp-cli
```

- [ ] **Step 2: Write the failing record test**

Create `eval-mocks/test/dispatcher-record.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dispatch } from "../src/dispatcher.js";
import { computeKey } from "../src/key.js";
import { cassettePath, auditPath } from "../src/store.js";

let fixtureDir: string;
const fakeCli = path.resolve(__dirname, "fixtures/fake-pp-cli");

beforeEach(() => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), "eval-record-"));
  mkdirSync(path.join(fixtureDir, ".anonymize"));
  writeFileSync(
    path.join(fixtureDir, ".anonymize", "global.yaml"),
    `patterns:\n  - { name: email, regex: '\\S+@\\S+\\.\\S+', strategy: hash, prefix: email_ }\nfield_names: []\n`,
  );
  writeFileSync(
    path.join(fixtureDir, ".anonymize", "fake-pp-cli.yaml"),
    `fields: []\nenv_whitelist: []\narg_normalization: flag-order-insensitive\nprose_doctor: false\n`,
  );
});

describe("dispatch (record mode)", () => {
  it("executes the real CLI, anonymizes, and persists the cassette", async () => {
    const stdoutChunks: string[] = [];
    const code = await dispatch({
      cli: "fake-pp-cli",
      argv: ["json"],
      stdin: "",
      env: {
        EVAL_MOCK_MODE: "record",
        EVAL_FIXTURE_DIR: fixtureDir,
        EVAL_REAL_CLI_PATH: fakeCli,
      },
      stdout: { write: (s) => { stdoutChunks.push(s); return true; } } as any,
      stderr: { write: () => true } as any,
    });

    expect(code).toBe(0);
    // Returned to caller anonymized
    expect(stdoutChunks.join("")).not.toContain("alice@example.com");
    expect(stdoutChunks.join("")).toMatch(/email_[0-9a-f]{8}/);

    // Cassette + audit on disk
    const key = computeKey({
      cli: "fake-pp-cli",
      argv: ["json"],
      stdin: "",
      env: {},
      envWhitelist: [],
      normalizeArgs: "flag-order-insensitive",
    });
    const cassetteOnDisk = JSON.parse(readFileSync(cassettePath(fixtureDir, key), "utf8"));
    expect(cassetteOnDisk.response.stdout).not.toContain("alice@example.com");
    expect(cassetteOnDisk.meta.cli_version).toContain("fake-pp-cli");

    const audit = JSON.parse(readFileSync(auditPath(fixtureDir, key), "utf8"));
    expect(audit.redactions.length).toBeGreaterThan(0);
  });

  it("propagates non-zero exit codes from the real CLI", async () => {
    const code = await dispatch({
      cli: "fake-pp-cli",
      argv: ["fail"],
      stdin: "",
      env: {
        EVAL_MOCK_MODE: "record",
        EVAL_FIXTURE_DIR: fixtureDir,
        EVAL_REAL_CLI_PATH: fakeCli,
      },
      stdout: { write: () => true } as any,
      stderr: { write: () => true } as any,
    });
    expect(code).toBe(5);
  });

  it("in record-missing mode, replays existing cassettes and records new ones", async () => {
    // First call records.
    await dispatch({
      cli: "fake-pp-cli",
      argv: ["json"],
      stdin: "",
      env: {
        EVAL_MOCK_MODE: "record-missing",
        EVAL_FIXTURE_DIR: fixtureDir,
        EVAL_REAL_CLI_PATH: fakeCli,
      },
      stdout: { write: () => true } as any,
      stderr: { write: () => true } as any,
    });

    const key = computeKey({
      cli: "fake-pp-cli",
      argv: ["json"],
      stdin: "",
      env: {},
      envWhitelist: [],
      normalizeArgs: "flag-order-insensitive",
    });
    expect(existsSync(cassettePath(fixtureDir, key))).toBe(true);

    // Second call should replay (we point EVAL_REAL_CLI_PATH at /dev/null
    // so a real exec would fail).
    const stdoutChunks: string[] = [];
    const code = await dispatch({
      cli: "fake-pp-cli",
      argv: ["json"],
      stdin: "",
      env: {
        EVAL_MOCK_MODE: "record-missing",
        EVAL_FIXTURE_DIR: fixtureDir,
        EVAL_REAL_CLI_PATH: "/dev/null",
      },
      stdout: { write: (s) => { stdoutChunks.push(s); return true; } } as any,
      stderr: { write: () => true } as any,
    });
    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toMatch(/email_[0-9a-f]{8}/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run eval-mocks/test/dispatcher-record.test.ts
```

Expected: FAIL — record path not yet implemented.

- [ ] **Step 4: Implement record path in `dispatcher.ts`**

Replace the `// record / record-missing — implemented in Task 9` block at the bottom of `dispatcher.ts` with the full implementation. The whole file should now read:

```typescript
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Cassette, AuditLog, MockMode, CliRules } from "./types.js";
import { DISPATCHER_SCHEMA_VERSION } from "./types.js";
import { computeKey, normalizeArgv } from "./key.js";
import { readCassette, writeCassette, regenerateIndex } from "./store.js";
import { loadRules, getCliRules } from "./anonymizer-rules.js";
import { anonymize } from "./anonymizer.js";

export const EXIT_MOCK_MISS = 87;

export interface DispatchOptions {
  cli: string;
  argv: string[];
  stdin: string;
  env: Record<string, string | undefined>;
  stdout: { write: (s: string) => boolean };
  stderr: { write: (s: string) => boolean };
}

function getMode(env: Record<string, string | undefined>): MockMode {
  const m = (env.EVAL_MOCK_MODE ?? "replay").toLowerCase();
  if (m === "replay" || m === "record" || m === "record-missing") return m;
  throw new Error(`EVAL_MOCK_MODE must be replay|record|record-missing, got: ${m}`);
}

/**
 * Resolve the real CLI binary to invoke during record. Honors
 * EVAL_REAL_CLI_PATH (used by tests). Otherwise, falls back to looking
 * up the CLI by name on PATH after stripping the eval-mocks/bin entry.
 *
 * Strip is needed because the dispatcher itself is on PATH under the
 * same name; without stripping we'd recursively invoke ourselves.
 */
function resolveRealCli(cli: string, env: Record<string, string | undefined>): string {
  if (env.EVAL_REAL_CLI_PATH) return env.EVAL_REAL_CLI_PATH;
  const pathParts = (env.PATH ?? "").split(":");
  const mockBin = env.EVAL_MOCK_BIN_DIR;
  const filtered = mockBin ? pathParts.filter((p) => p !== mockBin) : pathParts;
  for (const dir of filtered) {
    const candidate = `${dir}/${cli}`;
    if (existsSync(candidate)) return candidate;
  }
  return cli; // fallback; spawnSync will fail with a clear error
}

function captureCliVersion(realCli: string, env: NodeJS.ProcessEnv): string {
  try {
    const out = spawnSync(realCli, ["--version"], {
      env, encoding: "utf8", timeout: 5_000,
    });
    if (out.status === 0) return out.stdout.trim() || out.stderr.trim() || "unknown";
  } catch { /* fall through */ }
  return "unknown";
}

function isJsonOutput(stdout: string, cliRules: CliRules, argv: string[]): boolean {
  if (cliRules.prose_doctor && argv[0] === "doctor") return false;
  const trimmed = stdout.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

export async function dispatch(opts: DispatchOptions): Promise<number> {
  const mode = getMode(opts.env);
  const fixtureDir = opts.env.EVAL_FIXTURE_DIR;
  if (!fixtureDir) {
    opts.stderr.write("EVAL_FIXTURE_DIR is required\n");
    return 2;
  }

  const rules = loadRules(fixtureDir);
  const cliRules = getCliRules(rules, opts.cli);

  const envForKey: Record<string, string> = {};
  for (const k of cliRules.env_whitelist) {
    if (opts.env[k] !== undefined) envForKey[k] = opts.env[k] as string;
  }

  const key = computeKey({
    cli: opts.cli,
    argv: opts.argv,
    stdin: opts.stdin,
    env: envForKey,
    envWhitelist: cliRules.env_whitelist,
    normalizeArgs: cliRules.arg_normalization,
  });

  // Try replay first (always — record-missing mode reuses if hit)
  const existing = readCassette(fixtureDir, key);
  if (existing && (mode === "replay" || mode === "record-missing")) {
    if (existing.response.stdout) opts.stdout.write(existing.response.stdout);
    if (existing.response.stderr) opts.stderr.write(existing.response.stderr);
    return existing.response.exit_code;
  }

  if (mode === "replay") {
    const expected = `${fixtureDir}/${key.cli}/${key.slug}__${key.hash}.json`;
    opts.stderr.write(
      `EVAL_MOCK_MISS ${opts.cli} ${key.slug}\n` +
      `  expected fixture: ${expected}\n` +
      `  re-record with: EVAL_MOCK_MODE=record-missing npm run local-eval\n`,
    );
    return EXIT_MOCK_MISS;
  }

  // record or record-missing miss → exec the real CLI
  const realCli = resolveRealCli(opts.cli, opts.env);
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(opts.env)) {
    if (v !== undefined) childEnv[k] = v;
  }
  const result = spawnSync(realCli, opts.argv, {
    input: opts.stdin,
    env: childEnv,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });

  if (result.error) {
    opts.stderr.write(
      `eval-dispatcher: failed to exec real CLI ${realCli}: ${result.error.message}\n`,
    );
    return 78;
  }

  const realStdout = result.stdout ?? "";
  const realStderr = result.stderr ?? "";
  const exitCode = result.status ?? 0;

  // Anonymize stdout (and stderr) before persisting AND before returning.
  const anon = anonymize({
    cli: opts.cli,
    output: realStdout,
    rules,
    isJson: isJsonOutput(realStdout, cliRules, opts.argv),
  });
  const anonStderr = anonymize({
    cli: opts.cli,
    output: realStderr,
    rules,
    isJson: false,
  });

  const cassette: Cassette = {
    request: {
      cli: opts.cli,
      argv: normalizeArgv(opts.argv, cliRules.arg_normalization),
      argv_raw: opts.argv,
      stdin: opts.stdin,
      env_subset: envForKey,
    },
    response: {
      stdout: anon.output,
      stderr: anonStderr.output,
      exit_code: exitCode,
    },
    meta: {
      recorded_at: new Date().toISOString(),
      cli_version: captureCliVersion(realCli, childEnv),
      dispatcher_version: DISPATCHER_SCHEMA_VERSION,
    },
  };

  const audit: AuditLog = {
    cassette: `${key.slug}__${key.hash}.json`,
    redactions: [...anon.redactions, ...anonStderr.redactions],
    notes: [...anon.notes, ...anonStderr.notes],
  };

  writeCassette(fixtureDir, key, cassette, audit);
  regenerateIndex(fixtureDir);

  opts.stdout.write(anon.output);
  opts.stderr.write(anonStderr.output);
  return exitCode;
}
```

- [ ] **Step 5: Run all dispatcher tests**

```bash
npx vitest run eval-mocks/test/dispatcher-replay.test.ts eval-mocks/test/dispatcher-record.test.ts
```

Expected: all PASS (replay tests still pass; record tests pass).

- [ ] **Step 6: Run the full test suite**

```bash
npx vitest run
```

Expected: every test in the suite passes.

- [ ] **Step 7: Commit**

```bash
git add eval-mocks/src/dispatcher.ts eval-mocks/test/dispatcher-record.test.ts \
        eval-mocks/test/fixtures/fake-pp-cli
git commit -m "feat(eval): add dispatcher record + record-missing modes

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: CLI entrypoint with shebang + symlink setup

**Files:**
- Create: `clis-worker/eval-mocks/src/cli.ts`
- Create: `clis-worker/eval-mocks/scripts/setup-symlinks.ts`
- Modify: `clis-worker/tsconfig.json`

- [ ] **Step 1: Add `eval-mocks/` and `scripts/` to tsconfig include**

Read the current `tsconfig.json`:

```bash
cat tsconfig.json
```

Then edit to ensure `include` covers eval-mocks. Final shape:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": ".",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*", "eval-mocks/src/**/*", "eval-mocks/scripts/**/*", "scripts/**/*"]
}
```

(If existing `tsconfig.json` already differs, preserve its options and just merge the `include` array. Adjust `rootDir` to `.` if it was previously `src`, since we now have files outside `src/`.)

- [ ] **Step 2: Create the CLI entrypoint**

Create `eval-mocks/src/cli.ts`:

```typescript
#!/usr/bin/env node
// Entrypoint for the mock-cli dispatcher. Symlinked under each CLI's
// name (e.g. eval-mocks/bin/slack-pp-cli → ../dist/eval-mocks/src/cli.js)
// so the worker's Bash tool resolves CLI names to this script.
//
// argv[0]   = node
// argv[1]   = absolute path of the symlink that was invoked
// argv[2..] = the CLI's own arguments
//
// We resolve argv[1]'s basename to determine which CLI we're impersonating.

import path from "node:path";
import { dispatch } from "./dispatcher.js";

async function main(): Promise<number> {
  const invokedAs = process.argv[1] ?? "";
  const cli = path.basename(invokedAs);
  if (!cli) {
    process.stderr.write("eval-mocks/cli: cannot determine CLI name\n");
    return 2;
  }

  const argv = process.argv.slice(2);

  // Read all of stdin synchronously if any was piped. Agent commands
  // usually don't pipe; the slack POST workaround does.
  let stdin = "";
  if (!process.stdin.isTTY) {
    stdin = await readStdin();
  }

  return dispatch({
    cli,
    argv,
    stdin,
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

main().then((code) => process.exit(code), (err) => {
  process.stderr.write(`eval-mocks/cli: unexpected error: ${err?.stack ?? err}\n`);
  process.exit(1);
});
```

- [ ] **Step 3: Create the symlink setup script**

Create `eval-mocks/scripts/setup-symlinks.ts`:

```typescript
import {
  existsSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync, lstatSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ESM compat: __dirname is not defined in ES modules.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Canonical CLI list. Mirrors the SYSTEM_PROMPT in src/server.ts. When a
// new CLI is added to the worker, add it here too.
const CLIS = [
  "slack-pp-cli",
  "scrape-creators-pp-cli",
  "contentful-pp-cli",
  "ga4-pp-cli",
  "screaming-frog-pp-cli",
];

const repoRoot = path.resolve(__dirname, "..", "..");
const binDir = path.join(repoRoot, "eval-mocks", "bin");
// Built artifact path. tsc emits eval-mocks/src/cli.ts → dist/eval-mocks/src/cli.js
const target = path.join(repoRoot, "dist", "eval-mocks", "src", "cli.js");

if (!existsSync(target)) {
  console.error(
    `setup-symlinks: build artifact missing at ${target}\n` +
    `Run \`npm run build\` first.`,
  );
  process.exit(1);
}

if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });

// Idempotent: if the link exists pointing to the right target, skip.
// If it exists pointing elsewhere, remove and recreate.
let created = 0;
let updated = 0;
for (const cli of CLIS) {
  const link = path.join(binDir, cli);
  const relTarget = path.relative(binDir, target);

  if (existsSync(link) || lstatExists(link)) {
    let existing: string | null = null;
    try { existing = readlinkSync(link); } catch { /* not a symlink */ }
    if (existing === relTarget) continue;
    unlinkSync(link);
    updated++;
  } else {
    created++;
  }
  symlinkSync(relTarget, link);
}

console.log(
  `setup-symlinks: ${created} created, ${updated} updated, ${CLIS.length - created - updated} unchanged`,
);

function lstatExists(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
}
```

- [ ] **Step 4: Build and run setup**

```bash
npm run build
npm run eval:setup
```

Expected: `setup-symlinks: 5 created, 0 updated, 0 unchanged`. Verify symlinks:

```bash
ls -la eval-mocks/bin/
```

Expected: 5 symlinks pointing to `../../dist/eval-mocks/src/cli.js`.

- [ ] **Step 5: Smoke-test the dispatcher binary**

```bash
EVAL_MOCK_MODE=replay EVAL_FIXTURE_DIR=eval-fixtures eval-mocks/bin/slack-pp-cli channels list --agent
echo "exit: $?"
```

Expected: `EVAL_MOCK_MISS slack-pp-cli channels-list--agent` on stderr, exit code 87.

- [ ] **Step 6: Commit**

```bash
git add eval-mocks/src/cli.ts eval-mocks/scripts/setup-symlinks.ts tsconfig.json
git commit -m "feat(eval): add dispatcher entrypoint and symlink setup

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: End-to-end integration test (record → replay → miss)

**Files:**
- Create: `clis-worker/eval-mocks/test/integration.test.ts`

- [ ] **Step 1: Write the integration test**

Create `eval-mocks/test/integration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(__dirname, "../..");
const fakeCli = path.join(repoRoot, "eval-mocks/test/fixtures/fake-pp-cli");

let fixtureDir: string;
let mockBinDir: string;
let dispatcherTarget: string;

beforeAll(() => {
  // The dispatcher binary must be built before this test runs.
  dispatcherTarget = path.join(repoRoot, "dist/eval-mocks/src/cli.js");
  if (!existsSync(dispatcherTarget)) {
    throw new Error(
      `dispatcher not built at ${dispatcherTarget}. ` +
      `Run \`npm run build\` before this test.`,
    );
  }
});

beforeEach(() => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), "eval-int-"));
  mkdirSync(path.join(fixtureDir, ".anonymize"));
  writeFileSync(
    path.join(fixtureDir, ".anonymize/global.yaml"),
    "patterns:\n  - { name: email, regex: '\\S+@\\S+\\.\\S+', strategy: hash, prefix: email_ }\nfield_names: []\n",
  );
  writeFileSync(
    path.join(fixtureDir, ".anonymize/fake-pp-cli.yaml"),
    "fields: []\nenv_whitelist: []\narg_normalization: flag-order-insensitive\nprose_doctor: false\n",
  );

  // Per-test bin dir with one symlink pretending to be fake-pp-cli
  mockBinDir = mkdtempSync(path.join(tmpdir(), "eval-bin-"));
  spawnSync("ln", ["-s", dispatcherTarget, path.join(mockBinDir, "fake-pp-cli")]);
});

function runDispatcher(argv: string[], mode: string): { stdout: string; stderr: string; code: number } {
  const linkPath = path.join(mockBinDir, "fake-pp-cli");
  const out = spawnSync("node", [linkPath, ...argv], {
    env: {
      ...process.env,
      EVAL_MOCK_MODE: mode,
      EVAL_FIXTURE_DIR: fixtureDir,
      EVAL_REAL_CLI_PATH: fakeCli,
    },
    encoding: "utf8",
  });
  return { stdout: out.stdout ?? "", stderr: out.stderr ?? "", code: out.status ?? -1 };
}

describe("end-to-end record/replay/miss", () => {
  it("records a real invocation, then replays from cassette", () => {
    const rec = runDispatcher(["json"], "record");
    expect(rec.code).toBe(0);
    expect(rec.stdout).toMatch(/email_[0-9a-f]{8}/);
    expect(rec.stdout).not.toContain("alice@example.com");

    // Move the real CLI out of the way to prove replay isn't shelling out.
    const moved = `${fakeCli}.moved`;
    renameSync(fakeCli, moved);
    try {
      const rep = runDispatcher(["json"], "replay");
      expect(rep.code).toBe(0);
      expect(rep.stdout).toBe(rec.stdout);
    } finally {
      renameSync(moved, fakeCli);
    }
  });

  it("returns EXIT_MOCK_MISS in replay mode when no cassette exists", () => {
    const r = runDispatcher(["unrecorded"], "replay");
    expect(r.code).toBe(87);
    expect(r.stderr).toContain("EVAL_MOCK_MISS");
  });

  it("propagates non-JSON prose output through pattern scan only", () => {
    const r = runDispatcher(["prose"], "record");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/email_[0-9a-f]{8}/);
    expect(r.stdout).toContain("auth ok for");
  });

  it("propagates non-zero exit codes through replay", () => {
    runDispatcher(["fail"], "record"); // record the failure
    const r = runDispatcher(["fail"], "replay");
    expect(r.code).toBe(5);
  });
});
```

- [ ] **Step 2: Build and run the integration test**

```bash
npm run build
npx vitest run eval-mocks/test/integration.test.ts
```

Expected: all 4 tests PASS. The first test exercises record → cassette persistence → replay; the others verify miss handling, non-JSON, and exit-code propagation.

- [ ] **Step 3: Commit**

```bash
git add eval-mocks/test/integration.test.ts
git commit -m "test(eval): add end-to-end record/replay/miss integration test

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Eval prompt set loader

**Files:**
- Create: `clis-worker/scripts/eval-prompts.ts`
- Create: `clis-worker/scripts/test/eval-prompts.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/test/eval-prompts.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPrompts, filterPrompts } from "../eval-prompts.js";

describe("loadPrompts", () => {
  it("loads from a JSON file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eval-p-"));
    const file = path.join(dir, "prompts.json");
    writeFileSync(file, JSON.stringify([
      { category: "doctor", label: "x", prompt: "say hi" },
      { category: "task", label: "y", prompt: "do it" },
    ]));
    const prompts = loadPrompts(file);
    expect(prompts).toHaveLength(2);
    expect(prompts[0].label).toBe("x");
  });

  it("throws on missing file with a helpful error", () => {
    expect(() => loadPrompts("/nonexistent.json"))
      .toThrow(/prompts file not found/);
  });

  it("throws on invalid JSON shape", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eval-p-"));
    const file = path.join(dir, "bad.json");
    writeFileSync(file, JSON.stringify({ not: "an array" }));
    expect(() => loadPrompts(file)).toThrow(/expected an array/);
  });
});

describe("filterPrompts", () => {
  const all = [
    { category: "doctor", label: "slack doctor", prompt: "..." },
    { category: "doctor", label: "ga4 doctor", prompt: "..." },
    { category: "task", label: "Slack: list channels", prompt: "..." },
    { category: "task", label: "No tool: hello", prompt: "..." },
  ];

  it("returns all when no filter", () => {
    expect(filterPrompts(all, {})).toEqual(all);
  });

  it("filters by label substring", () => {
    expect(filterPrompts(all, { include: ["slack"] })).toHaveLength(2);
  });

  it("excludes by label substring", () => {
    expect(filterPrompts(all, { exclude: ["No tool"] })).toHaveLength(3);
  });

  it("filters by category", () => {
    expect(filterPrompts(all, { categories: ["doctor"] })).toHaveLength(2);
  });

  it("composes include + exclude + categories", () => {
    const r = filterPrompts(all, { include: ["slack"], categories: ["doctor"] });
    expect(r).toHaveLength(1);
    expect(r[0].label).toBe("slack doctor");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run scripts/test/eval-prompts.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `eval-prompts.ts`**

Create `scripts/eval-prompts.ts`:

```typescript
import { readFileSync, existsSync } from "node:fs";

export interface EvalPrompt {
  category: string;
  label: string;
  prompt: string;
}

export interface FilterOpts {
  include?: string[];      // case-insensitive label substring match
  exclude?: string[];      // case-insensitive label substring match
  categories?: string[];   // exact category match
}

/**
 * Load prompts from a JSON file. Falls back to clis-worker-ui's
 * prompts.json by convention if the path is omitted by the caller.
 */
export function loadPrompts(file: string): EvalPrompt[] {
  if (!existsSync(file)) {
    throw new Error(`prompts file not found: ${file}`);
  }
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`prompts file must contain an array, got ${typeof parsed}: ${file}`);
  }
  for (const p of parsed) {
    if (!p.category || !p.label || !p.prompt) {
      throw new Error(`prompt missing required field (category/label/prompt): ${JSON.stringify(p)}`);
    }
  }
  return parsed as EvalPrompt[];
}

export function filterPrompts(prompts: EvalPrompt[], opts: FilterOpts): EvalPrompt[] {
  const inc = (opts.include ?? []).map((s) => s.toLowerCase());
  const exc = (opts.exclude ?? []).map((s) => s.toLowerCase());
  const cats = new Set(opts.categories ?? []);
  return prompts.filter((p) => {
    const label = p.label.toLowerCase();
    if (cats.size > 0 && !cats.has(p.category)) return false;
    if (inc.length > 0 && !inc.some((s) => label.includes(s))) return false;
    if (exc.some((s) => label.includes(s))) return false;
    return true;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run scripts/test/eval-prompts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/eval-prompts.ts scripts/test/eval-prompts.test.ts
git commit -m "feat(eval): add prompt loader with filter helpers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Eval orchestrator — server lifecycle

**Files:**
- Create: `clis-worker/scripts/eval-server.ts`
- Create: `clis-worker/scripts/test/eval-server.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/test/eval-server.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { startWorker, stopWorker } from "../eval-server.js";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../..");

describe("startWorker / stopWorker", () => {
  it("spawns the worker, polls /health, and stops cleanly", async () => {
    const handle = await startWorker({
      port: 4789,
      env: {
        EVAL_MOCK_MODE: "replay",
        EVAL_FIXTURE_DIR: path.join(repoRoot, "eval-fixtures"),
        EVAL_MOCK_BIN_DIR: path.join(repoRoot, "eval-mocks/bin"),
        // Use an empty WORKER_API_KEY so /agent doesn't require auth
        WORKER_API_KEY: "",
        // Use a small data dir
        PRESS_DATA_DIR: "/tmp/eval-press-data-test",
      },
      cwd: repoRoot,
      timeoutMs: 30_000,
    });

    expect(handle.port).toBe(4789);
    expect(handle.url).toBe("http://localhost:4789");

    // /health should respond 200
    const res = await fetch(`${handle.url}/health`);
    expect(res.status).toBe(200);

    await stopWorker(handle);

    // After stop, /health should fail
    let stopped = false;
    try {
      await fetch(`${handle.url}/health`, { signal: AbortSignal.timeout(2000) });
    } catch {
      stopped = true;
    }
    expect(stopped).toBe(true);
  }, 60_000);

  it("times out if /health never responds", async () => {
    await expect(startWorker({
      port: 4790,
      env: { /* missing required env will likely cause startup to fail */ },
      cwd: "/tmp",  // wrong cwd; tsx won't find src/server.ts
      timeoutMs: 5_000,
    })).rejects.toThrow(/health.*did not respond|spawn.*failed|exited/i);
  }, 15_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run scripts/test/eval-server.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `eval-server.ts`**

Create `scripts/eval-server.ts`:

```typescript
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

export interface WorkerHandle {
  process: ChildProcess;
  port: number;
  url: string;
  stderrLogPath: string;
}

export interface StartOpts {
  port: number;
  env: Record<string, string | undefined>;
  cwd: string;
  timeoutMs?: number;
  stderrLogPath?: string;
}

export async function startWorker(opts: StartOpts): Promise<WorkerHandle> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const stderrLogPath = opts.stderrLogPath ?? path.join(opts.cwd, "worker-stderr.log");

  if (!existsSync(path.dirname(stderrLogPath))) {
    mkdirSync(path.dirname(stderrLogPath), { recursive: true });
  }
  const stderrLog = createWriteStream(stderrLogPath);

  // Build the env. Strip undefined.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env)) {
    if (v !== undefined) env[k] = v;
  }
  // Always set PORT so the worker binds where we expect.
  env.PORT = String(opts.port);

  // Use tsx to run src/server.ts directly (no build step required for the
  // worker itself; only the dispatcher needs a build because PATH symlinks
  // need a real .js file).
  const proc = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: opts.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout.on("data", () => { /* swallow stdout */ });
  proc.stderr.on("data", (chunk) => stderrLog.write(chunk));

  let exitedEarly: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  proc.on("exit", (code, signal) => {
    exitedEarly = { code, signal };
    stderrLog.end();
  });

  const url = `http://localhost:${opts.port}`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (exitedEarly) {
      throw new Error(
        `worker exited before /health was ready (code=${exitedEarly.code}, signal=${exitedEarly.signal}). ` +
        `See ${stderrLogPath}`,
      );
    }
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.status === 200) {
        return { process: proc, port: opts.port, url, stderrLogPath };
      }
    } catch {
      /* not yet */
    }
    await sleep(500);
  }

  proc.kill("SIGTERM");
  throw new Error(`worker /health did not respond within ${timeoutMs}ms. See ${stderrLogPath}`);
}

export async function stopWorker(handle: WorkerHandle): Promise<void> {
  if (handle.process.killed || handle.process.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    handle.process.once("exit", () => resolve());
    handle.process.kill("SIGTERM");
    setTimeout(() => {
      if (handle.process.exitCode === null) handle.process.kill("SIGKILL");
    }, 5000);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run build  # ensure dist/ is fresh in case server.ts depends on it
npx vitest run scripts/test/eval-server.test.ts
```

Expected: PASS. (First test takes 5–15s — worker needs to start.)

If the timeout test fails because `tsx src/server.ts` from `/tmp` produces a different error than expected, adjust the `toThrow` regex accordingly.

- [ ] **Step 5: Commit**

```bash
git add scripts/eval-server.ts scripts/test/eval-server.test.ts
git commit -m "feat(eval): add worker spawn/stop lifecycle helpers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: Eval orchestrator — prompt iteration and result capture

**Files:**
- Create: `clis-worker/scripts/eval-runner.ts`
- Create: `clis-worker/scripts/local-eval.ts`

- [ ] **Step 1: Implement `eval-runner.ts` (the prompt loop)**

Create `scripts/eval-runner.ts`:

```typescript
import type { EvalPrompt } from "./eval-prompts.js";

export interface PromptResult {
  category: string;
  label: string;
  prompt: string;
  session_id?: string;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  is_error?: boolean;
  // Local-eval-only:
  tool_calls?: number;
  mock_misses?: number;
  // For debugging:
  raw_events?: any[];
}

/**
 * Send one prompt to the worker's /agent endpoint, parse the NDJSON
 * stream, and synthesize a PromptResult from the events.
 */
export async function runOnePrompt(
  workerUrl: string,
  prompt: EvalPrompt,
  apiKey: string,
): Promise<PromptResult> {
  const start = Date.now();
  const res = await fetch(`${workerUrl}/agent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ prompt: prompt.prompt }),
  });

  if (!res.ok) {
    return {
      category: prompt.category,
      label: prompt.label,
      prompt: prompt.prompt,
      is_error: true,
      duration_ms: Date.now() - start,
      raw_events: [{ http_error: res.status, body: await res.text() }],
    };
  }

  const events: any[] = [];
  let toolCalls = 0;
  let mockMisses = 0;
  let resultEvent: any = null;

  const decoder = new TextDecoder();
  let buffer = "";
  const reader = res.body!.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const evt = JSON.parse(line);
        events.push(evt);
        if (evt.type === "result") resultEvent = evt;
        // Count tool_use events from agent messages
        if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
          for (const block of evt.message.content) {
            if (block.type === "tool_use") toolCalls++;
          }
        }
        // Count EVAL_MOCK_MISS occurrences in tool_result content
        if (evt.type === "user" && Array.isArray(evt.message?.content)) {
          for (const block of evt.message.content) {
            if (block.type === "tool_result" && typeof block.content === "string"
                && block.content.includes("EVAL_MOCK_MISS")) {
              mockMisses++;
            }
            if (block.type === "tool_result" && Array.isArray(block.content)) {
              for (const sub of block.content) {
                if (sub.type === "text" && sub.text?.includes("EVAL_MOCK_MISS")) {
                  mockMisses++;
                }
              }
            }
          }
        }
      } catch {
        /* skip non-JSON lines */
      }
    }
  }

  return {
    category: prompt.category,
    label: prompt.label,
    prompt: prompt.prompt,
    session_id: resultEvent?.session_id,
    num_turns: resultEvent?.num_turns,
    duration_ms: resultEvent?.duration_ms ?? (Date.now() - start),
    total_cost_usd: resultEvent?.total_cost_usd,
    is_error: resultEvent?.is_error ?? !resultEvent,
    tool_calls: toolCalls,
    mock_misses: mockMisses,
    raw_events: events,
  };
}

/**
 * Run all prompts serially. Serial is critical: concurrent runs each
 * cache-miss the worker's system prompt and inflate baseline cost.
 */
export async function runAllPrompts(
  workerUrl: string,
  prompts: EvalPrompt[],
  apiKey: string,
  onProgress?: (idx: number, total: number, result: PromptResult) => void,
): Promise<PromptResult[]> {
  const out: PromptResult[] = [];
  for (let i = 0; i < prompts.length; i++) {
    const r = await runOnePrompt(workerUrl, prompts[i], apiKey);
    out.push(r);
    onProgress?.(i + 1, prompts.length, r);
  }
  return out;
}
```

- [ ] **Step 2: Implement the top-level `local-eval.ts`**

Create `scripts/local-eval.ts`:

```typescript
#!/usr/bin/env node
// Top-level orchestrator for `npm run local-eval`. Spawns the worker
// with mocked CLIs on PATH, sends the prompt set serially, writes the
// results to eval-runs/<date>-<slug>/.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startWorker, stopWorker } from "./eval-server.js";
import { loadPrompts, filterPrompts, type EvalPrompt } from "./eval-prompts.js";
import { runAllPrompts, type PromptResult } from "./eval-runner.js";

// ESM compat: __dirname is not defined in ES modules.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface CliArgs {
  mode: "replay" | "record" | "record-missing";
  output: "baseline" | "after";
  slug: string;
  promptsFile: string;
  port: number;
  include: string[];
  exclude: string[];
  categories: string[];
  samples: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    mode: "replay",
    output: "baseline",
    slug: new Date().toISOString().slice(11, 19).replace(/:/g, ""),
    promptsFile: path.resolve(__dirname, "../../clis-worker-ui/public/prompts.json"),
    port: Number(process.env.EVAL_PORT ?? 3787),
    include: [],
    exclude: [],
    categories: [],
    samples: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--mode") args.mode = next() as CliArgs["mode"];
    else if (a === "--output") args.output = next() as CliArgs["output"];
    else if (a === "--slug") args.slug = next();
    else if (a === "--prompts") args.promptsFile = path.resolve(next());
    else if (a === "--port") args.port = Number(next());
    else if (a === "--include") args.include.push(next());
    else if (a === "--exclude") args.exclude.push(next());
    else if (a === "--category") args.categories.push(next());
    else if (a === "--samples") args.samples = Number(next());
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  return args;
}

function printHelp(): void {
  console.log(`local-eval — run the prompt set against a locally-spawned worker with mocked CLIs.

Usage: npm run local-eval -- [options]

  --mode <replay|record|record-missing>   default replay
  --output <baseline|after>               default baseline; controls filename
  --slug <name>                           default = current time HHMMSS; eval-runs/<date>-<slug>/
  --prompts <path>                        default = clis-worker-ui/public/prompts.json
  --port <n>                              default = $EVAL_PORT or 3787
  --include <substr>                      filter prompts by label substring (repeatable)
  --exclude <substr>                      exclude prompts by label substring (repeatable)
  --category <name>                       restrict to category (repeatable)
  --samples <n>                           run each prompt N times (default 1)
`);
}

function loadDotEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, "..");
  const fixtureDir = path.join(repoRoot, "eval-fixtures");
  const mockBinDir = path.join(repoRoot, "eval-mocks/bin");
  const today = new Date().toISOString().slice(0, 10);
  const runDir = path.join(repoRoot, "eval-runs", `${today}-${args.slug}`);
  mkdirSync(runDir, { recursive: true });

  // Build env: pinned eval values for replay; passthrough host env for record.
  const evalEnv = loadDotEnv(path.join(fixtureDir, ".env.eval"));
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${mockBinDir}:${process.env.PATH ?? ""}`,
    EVAL_MOCK_MODE: args.mode,
    EVAL_FIXTURE_DIR: fixtureDir,
    EVAL_MOCK_BIN_DIR: mockBinDir,
  };
  if (args.mode === "replay") {
    Object.assign(childEnv, evalEnv);
  }
  // Allow no auth so curl-without-key works locally
  childEnv.WORKER_API_KEY = "";

  // Load + filter prompts
  const all = loadPrompts(args.promptsFile);
  const prompts = filterPrompts(all, {
    include: args.include,
    exclude: args.exclude,
    categories: args.categories,
  });
  if (prompts.length === 0) {
    console.error("No prompts after filtering.");
    process.exit(2);
  }

  console.log(`Local eval — ${prompts.length} prompts × ${args.samples} sample(s), mode=${args.mode}, port=${args.port}`);
  console.log(`Run dir: ${runDir}`);

  // Spawn worker
  const handle = await startWorker({
    port: args.port,
    env: childEnv,
    cwd: repoRoot,
    timeoutMs: 60_000,
    stderrLogPath: path.join(runDir, "worker-stderr.log"),
  });
  console.log(`Worker up at ${handle.url} (pid ${handle.process.pid})`);

  let allResults: PromptResult[] = [];
  try {
    for (let s = 0; s < args.samples; s++) {
      const tag = args.samples > 1 ? ` (sample ${s + 1}/${args.samples})` : "";
      console.log(`\n--- Iteration ${s + 1}${tag} ---`);
      const results = await runAllPrompts(handle.url, prompts, "", (idx, total, r) => {
        const flag = r.is_error ? "✗" : (r.mock_misses ? "⚠" : "✓");
        const turns = r.num_turns ?? "?";
        const tools = r.tool_calls ?? "?";
        const ms = r.duration_ms ?? "?";
        console.log(`  [${idx}/${total}] ${flag} ${r.label.padEnd(40)} turns=${turns} tools=${tools} ${ms}ms`);
      });
      allResults = allResults.concat(results);
    }
  } finally {
    await stopWorker(handle);
  }

  const outFile = path.join(runDir, `${args.output}.json`);
  writeFileSync(outFile, JSON.stringify({
    args,
    started_at: new Date().toISOString(),
    results: allResults,
  }, null, 2));
  console.log(`\nWrote ${allResults.length} results to ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Manual smoke**

```bash
# This will fail with EVAL_MOCK_MISS for every prompt since no cassettes
# are recorded yet — that's expected. We're checking the orchestration
# wires up correctly.
npm run local-eval -- --include hello --slug smoke-orchestration
```

Expected output:
- Worker starts, /health returns 200
- 1 prompt runs ("No tool: hello" — doesn't invoke any CLI, so no MOCK_MISS)
- Result has `tool_calls=0`, `is_error=false`
- File written to `eval-runs/<today>-smoke-orchestration/baseline.json`

If the worker fails to start because of the missing `ANTHROPIC_API_KEY` / no MAX session, surface this clearly to the user before continuing — the rest of the plan assumes the SDK can authenticate.

- [ ] **Step 4: Commit**

```bash
git add scripts/eval-runner.ts scripts/local-eval.ts
git commit -m "feat(eval): add prompt iteration and local-eval orchestrator

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: Comparison reporter

**Files:**
- Create: `clis-worker/scripts/eval-report.ts`
- Create: `clis-worker/scripts/test/eval-report.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/test/eval-report.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { compare, formatReport } from "../eval-report.js";
import type { PromptResult } from "../eval-runner.js";

const baseline: PromptResult[] = [
  { category: "task", label: "A", prompt: "...", num_turns: 8, tool_calls: 4, duration_ms: 12000, is_error: false, mock_misses: 0 },
  { category: "task", label: "B", prompt: "...", num_turns: 14, tool_calls: 11, duration_ms: 31000, is_error: false, mock_misses: 0 },
  { category: "task", label: "C", prompt: "...", num_turns: 9, tool_calls: 5, duration_ms: 18000, is_error: false, mock_misses: 0 },
];

const after: PromptResult[] = [
  { category: "task", label: "A", prompt: "...", num_turns: 5, tool_calls: 2, duration_ms: 7000, is_error: false, mock_misses: 0 },
  { category: "task", label: "B", prompt: "...", num_turns: 14, tool_calls: 11, duration_ms: 30000, is_error: false, mock_misses: 0 },
  { category: "task", label: "C", prompt: "...", num_turns: 12, tool_calls: 8, duration_ms: 26000, is_error: false, mock_misses: 1 },
];

describe("compare", () => {
  it("computes per-prompt deltas", () => {
    const cmp = compare(baseline, after);
    expect(cmp.rows).toHaveLength(3);
    const a = cmp.rows.find((r) => r.label === "A")!;
    expect(a.delta_turns).toBe(-3);
    expect(a.delta_tool_calls).toBe(-2);
    expect(a.status).toBe("OK");
  });

  it("flags mock-miss-degraded rows", () => {
    const cmp = compare(baseline, after);
    const c = cmp.rows.find((r) => r.label === "C")!;
    expect(c.status).toBe("DEGRADED");
  });

  it("flags regressions in turns or tool_calls", () => {
    const cmp = compare(baseline, after);
    const c = cmp.rows.find((r) => r.label === "C")!;
    expect(c.regressed).toBe(true);
  });

  it("computes aggregates", () => {
    const cmp = compare(baseline, after);
    expect(cmp.aggregates.total_turns_before).toBe(31);
    expect(cmp.aggregates.total_turns_after).toBe(31);
    expect(cmp.aggregates.regressions).toBe(1);
    expect(cmp.aggregates.mock_misses_after).toBe(1);
  });
});

describe("formatReport", () => {
  it("emits a markdown report containing each prompt and aggregates", () => {
    const cmp = compare(baseline, after);
    const md = formatReport(cmp, { samplesPerPrompt: 1 });
    expect(md).toContain("| A |");
    expect(md).toContain("| B |");
    expect(md).toContain("| C |");
    expect(md).toContain("DEGRADED");
    expect(md).toContain("Aggregates");
    expect(md).not.toContain("$cost");  // no cost in local mode
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run scripts/test/eval-report.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `eval-report.ts`**

Create `scripts/eval-report.ts`:

```typescript
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { PromptResult } from "./eval-runner.js";

export interface CompareRow {
  label: string;
  category: string;
  turns_before: number | null;
  turns_after: number | null;
  delta_turns: number | null;
  tool_calls_before: number | null;
  tool_calls_after: number | null;
  delta_tool_calls: number | null;
  duration_before: number | null;
  duration_after: number | null;
  delta_duration: number | null;
  mock_misses_before: number;
  mock_misses_after: number;
  status: "OK" | "NO CHANGE" | "DEGRADED" | "MISSING" | "ERROR";
  regressed: boolean;
}

export interface CompareResult {
  rows: CompareRow[];
  aggregates: {
    prompts: number;
    total_turns_before: number;
    total_turns_after: number;
    delta_turns: number;
    pct_turns: number;
    total_tool_calls_before: number;
    total_tool_calls_after: number;
    delta_tool_calls: number;
    pct_tool_calls: number;
    regressions: number;
    mock_misses_after: number;
  };
}

function avgByLabel(results: PromptResult[]): Map<string, PromptResult> {
  // When --samples > 1, multiple results per label exist. Average the
  // numerics; keep the label/category from the first one.
  const groups = new Map<string, PromptResult[]>();
  for (const r of results) {
    const arr = groups.get(r.label) ?? [];
    arr.push(r);
    groups.set(r.label, arr);
  }
  const out = new Map<string, PromptResult>();
  for (const [label, arr] of groups) {
    const avg = (key: keyof PromptResult): number | undefined => {
      const vs = arr.map((r) => r[key] as number).filter((n) => typeof n === "number");
      if (vs.length === 0) return undefined;
      return vs.reduce((a, b) => a + b, 0) / vs.length;
    };
    out.set(label, {
      category: arr[0].category,
      label,
      prompt: arr[0].prompt,
      num_turns: avg("num_turns"),
      tool_calls: avg("tool_calls"),
      duration_ms: avg("duration_ms"),
      mock_misses: arr.reduce((a, r) => a + (r.mock_misses ?? 0), 0),
      is_error: arr.some((r) => r.is_error),
    });
  }
  return out;
}

export function compare(baseline: PromptResult[], after: PromptResult[]): CompareResult {
  const b = avgByLabel(baseline);
  const a = avgByLabel(after);
  const labels = new Set([...b.keys(), ...a.keys()]);

  const rows: CompareRow[] = [];
  for (const label of labels) {
    const bi = b.get(label);
    const ai = a.get(label);
    const turnsB = bi?.num_turns ?? null;
    const turnsA = ai?.num_turns ?? null;
    const toolsB = bi?.tool_calls ?? null;
    const toolsA = ai?.tool_calls ?? null;
    const durB = bi?.duration_ms ?? null;
    const durA = ai?.duration_ms ?? null;
    const dT = (turnsA != null && turnsB != null) ? Math.round((turnsA - turnsB) * 10) / 10 : null;
    const dC = (toolsA != null && toolsB != null) ? Math.round((toolsA - toolsB) * 10) / 10 : null;
    const dD = (durA != null && durB != null) ? Math.round(durA - durB) : null;
    const missB = bi?.mock_misses ?? 0;
    const missA = ai?.mock_misses ?? 0;

    let status: CompareRow["status"] = "OK";
    let regressed = false;
    if (!bi || !ai) status = "MISSING";
    else if (bi.is_error || ai.is_error) status = "ERROR";
    else if (missA > missB) { status = "DEGRADED"; }
    else if ((dT ?? 0) === 0 && (dC ?? 0) === 0) status = "NO CHANGE";
    if ((dT ?? 0) > 0 || (dC ?? 0) > 0) regressed = true;

    rows.push({
      label,
      category: (bi ?? ai)!.category,
      turns_before: turnsB, turns_after: turnsA, delta_turns: dT,
      tool_calls_before: toolsB, tool_calls_after: toolsA, delta_tool_calls: dC,
      duration_before: durB, duration_after: durA, delta_duration: dD,
      mock_misses_before: missB, mock_misses_after: missA,
      status, regressed,
    });
  }

  const sum = (key: keyof CompareRow) =>
    rows.reduce((s, r) => s + ((r[key] as number) ?? 0), 0);

  const totalTurnsB = sum("turns_before");
  const totalTurnsA = sum("turns_after");
  const totalToolsB = sum("tool_calls_before");
  const totalToolsA = sum("tool_calls_after");

  return {
    rows: rows.sort((x, y) => x.label.localeCompare(y.label)),
    aggregates: {
      prompts: rows.length,
      total_turns_before: totalTurnsB,
      total_turns_after: totalTurnsA,
      delta_turns: totalTurnsA - totalTurnsB,
      pct_turns: totalTurnsB > 0 ? Math.round(((totalTurnsA - totalTurnsB) / totalTurnsB) * 100) : 0,
      total_tool_calls_before: totalToolsB,
      total_tool_calls_after: totalToolsA,
      delta_tool_calls: totalToolsA - totalToolsB,
      pct_tool_calls: totalToolsB > 0 ? Math.round(((totalToolsA - totalToolsB) / totalToolsB) * 100) : 0,
      regressions: rows.filter((r) => r.regressed).length,
      mock_misses_after: sum("mock_misses_after"),
    },
  };
}

export function formatReport(cmp: CompareResult, opts: { samplesPerPrompt: number }): string {
  let md = `# Local eval comparison\n\n`;
  md += `Generated: ${new Date().toISOString()}\n`;
  md += `Samples per prompt: ${opts.samplesPerPrompt}\n\n`;

  md += `| prompt | turns (b→a, Δ) | tool_calls (b→a, Δ) | duration ms (b→a) | misses (b→a) | status |\n`;
  md += `|---|---|---|---|---|---|\n`;
  for (const r of cmp.rows) {
    const turns = `${r.turns_before ?? "?"} → ${r.turns_after ?? "?"} (${r.delta_turns ?? "?"})`;
    const tools = `${r.tool_calls_before ?? "?"} → ${r.tool_calls_after ?? "?"} (${r.delta_tool_calls ?? "?"})`;
    const dur = `${r.duration_before ?? "?"} → ${r.duration_after ?? "?"}`;
    const miss = `${r.mock_misses_before} → ${r.mock_misses_after}`;
    md += `| ${r.label} | ${turns} | ${tools} | ${dur} | ${miss} | ${r.status}${r.regressed ? " ✗" : ""} |\n`;
  }

  const a = cmp.aggregates;
  md += `\n## Aggregates\n\n`;
  md += `- Prompts: ${a.prompts}\n`;
  md += `- Turns: ${a.total_turns_before} → ${a.total_turns_after} (${a.delta_turns >= 0 ? "+" : ""}${a.delta_turns}, ${a.pct_turns}%)\n`;
  md += `- Tool calls: ${a.total_tool_calls_before} → ${a.total_tool_calls_after} (${a.delta_tool_calls >= 0 ? "+" : ""}${a.delta_tool_calls}, ${a.pct_tool_calls}%)\n`;
  md += `- Regressions: ${a.regressions}\n`;
  md += `- Mock misses (after): ${a.mock_misses_after}\n`;
  if (opts.samplesPerPrompt === 1) {
    md += `\n_Note: --samples=1. Turn counts have ±1–2 LLM-noise; re-run with --samples 3 to confirm._\n`;
  }
  return md;
}

// CLI mode: `npm run eval:report -- <run-dir>`
async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error("Usage: npm run eval:report -- <eval-runs/<date>-<slug>>");
    process.exit(2);
  }
  const baseline = path.join(dir, "baseline.json");
  const after = path.join(dir, "after.json");
  if (!existsSync(baseline) || !existsSync(after)) {
    console.error(`Need both baseline.json and after.json in ${dir}`);
    process.exit(2);
  }
  const b = JSON.parse(readFileSync(baseline, "utf8"));
  const a = JSON.parse(readFileSync(after, "utf8"));
  const cmp = compare(b.results, a.results);
  const md = formatReport(cmp, { samplesPerPrompt: b.args?.samples ?? 1 });
  const out = path.join(dir, "report.md");
  writeFileSync(out, md);
  console.log(`Wrote ${out}`);
  console.log(md);
}

if (process.argv[1] && process.argv[1].endsWith("eval-report.ts") || process.argv[1]?.endsWith("eval-report.js")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run scripts/test/eval-report.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/eval-report.ts scripts/test/eval-report.test.ts
git commit -m "feat(eval): add comparison reporter with regression flagging

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 16: Smoke test script

**Files:**
- Create: `clis-worker/scripts/local-eval-smoke.ts`

- [ ] **Step 1: Implement the smoke script**

Create `scripts/local-eval-smoke.ts`:

```typescript
#!/usr/bin/env node
// Tripwire smoke test: spawns the worker, sends ONE prompt that hits the
// slack-pp-cli doctor cassette, asserts the cassette was used. Runs in
// <10s in CI. Fails clearly if the cassette is missing.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startWorker, stopWorker } from "./eval-server.js";
import { runOnePrompt } from "./eval-runner.js";

// ESM compat: __dirname is not defined in ES modules.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<number> {
  const repoRoot = path.resolve(__dirname, "..");
  const fixtureDir = path.join(repoRoot, "eval-fixtures");
  const mockBinDir = path.join(repoRoot, "eval-mocks/bin");

  // Bootstrap dependency: the slack doctor cassette must exist.
  // Walk eval-fixtures/slack-pp-cli/ to find a doctor__*.json — name
  // doesn't matter, only that it's there.
  const slackDir = path.join(fixtureDir, "slack-pp-cli");
  if (!existsSync(slackDir)) {
    console.error(
      `\nSmoke test prerequisite missing: no cassettes for slack-pp-cli.\n` +
      `Record one with:\n` +
      `  npm run local-eval -- --mode=record --include slack --include doctor --slug bootstrap\n`,
    );
    return 2;
  }

  const handle = await startWorker({
    port: 3787,
    cwd: repoRoot,
    timeoutMs: 30_000,
    env: {
      ...process.env,
      PATH: `${mockBinDir}:${process.env.PATH ?? ""}`,
      EVAL_MOCK_MODE: "replay",
      EVAL_FIXTURE_DIR: fixtureDir,
      EVAL_MOCK_BIN_DIR: mockBinDir,
      WORKER_API_KEY: "",
    },
  });

  try {
    const result = await runOnePrompt(handle.url, {
      category: "doctor",
      label: "smoke",
      prompt: "Run `slack-pp-cli doctor --agent` and report the result in one sentence.",
    }, "");

    console.log(`turns=${result.num_turns} tool_calls=${result.tool_calls} mock_misses=${result.mock_misses} is_error=${result.is_error}`);

    if (result.is_error) {
      console.error("Smoke test FAILED: prompt errored.");
      return 1;
    }
    if ((result.mock_misses ?? 0) > 0) {
      console.error("Smoke test FAILED: cassette miss for slack-pp-cli doctor.");
      return 1;
    }
    if ((result.tool_calls ?? 0) === 0) {
      console.error("Smoke test FAILED: agent did not invoke the CLI.");
      return 1;
    }
    console.log("Smoke test PASSED.");
    return 0;
  } finally {
    await stopWorker(handle);
  }
}

main().then((code) => process.exit(code), (err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify it fails cleanly with the bootstrap message**

```bash
npm run local-eval:smoke
```

Expected (since no cassettes exist yet): exit 2 with the bootstrap message printed. This confirms the failure-mode handling works.

- [ ] **Step 3: Commit**

```bash
git add scripts/local-eval-smoke.ts
git commit -m "feat(eval): add tripwire smoke test for the eval pipeline

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 17: Skill update — add `--local` mode to `run-evals`

**Files:**
- Modify: `.claude/skills/run-evals/SKILL.md` (NOTE: not in any git repo per CLAUDE.md)

- [ ] **Step 1: Read the existing skill**

```bash
cat /Users/adamharris/Documents/repos/clis/.claude/skills/run-evals/SKILL.md
```

- [ ] **Step 2: Edit the skill to add the --local mode**

Add a new section between "## Standing rules" and "## Worker layout" titled `## Local mode (--local / --mocked)`:

```markdown
## Local mode (--local / --mocked)

When the user passes `--local` (or says "local", "mocked", "with mocks"),
skip the deployed flow entirely and use the mocked local infrastructure
under `clis-worker/eval-mocks/`. Local mode runs the actual `clis-worker`
Hono server as a subprocess on `EVAL_PORT` (default 3787) with mocked CLI
binaries on PATH that serve VCR-style cassettes from
`clis-worker/eval-fixtures/`.

**Why local mode exists.** Free iteration on recipe changes — uses MAX
session via the bundled Claude Code subprocess (no Anthropic API cost),
mocks third-party APIs (no real Slack/Contentful/GA4 calls). The deployed
eval remains the source of truth for "did this recipe save real $cost on
Haiku."

**When to use local vs. deployed.**
- **Local** for tight edit-test loops, before-and-after on a single recipe
  candidate, CI checks. Default for the recipe-tuning loop.
- **Deployed** for pre-merge confirmation, periodic API-drift checks,
  measuring real $cost impact.

**Local-mode phase changes:**

| Phase | Local-mode behavior |
|---|---|
| 0 Setup | Verify `clis-worker/eval-mocks/bin/` populated (`npm run eval:setup` if not). Verify Claude Code MAX session is logged in (the worker's Agent SDK uses the local Claude Code subprocess for auth). No `WORKER_API_KEY` needed. |
| 1 Baseline | `npm run local-eval -- --output baseline --slug <session-slug>`. Cost cap is N/A (free on MAX). |
| 2 Review | Same `review-worker-transcripts` skill, scoped to `clis-worker/eval-runs/<date>-<slug>/baseline.json` raw events. |
| 3 Apply | Edit recipe files. Commit locally. **Skip the "push it?" step** — no deploy needed for local. |
| 4 Push & redeploy | **Skipped** for local. |
| 5 After | `npm run local-eval -- --output after --slug <session-slug>`. |
| 6 Report | `npm run eval:report -- clis-worker/eval-runs/<date>-<slug>`. Report omits `$cost` (always $0); replaces with `tool_calls` and `mock_misses` columns. |
| 7 Disposition | Headline numbers + suggest running deployed eval to confirm before pushing recipe upstream. |

**Mock recording.** When the agent runs a CLI command that has no
cassette, the dispatcher exits 87 with `EVAL_MOCK_MISS`. To record:

```bash
npm run local-eval -- --mode=record-missing --output baseline --slug <slug>
```

This calls real CLIs only for misses; existing cassettes still replay.
Real CLIs need real auth — the user's normal shell `.env` overrides
`eval-fixtures/.env.eval` in record/record-missing mode.

**Cassette PII.** Cassettes are anonymized on the fly during recording
(see `clis-worker/eval-mocks/src/anonymizer.ts` and
`eval-fixtures/.anonymize/*.yaml`). Reference integrity is preserved
across cassettes via deterministic hashing. If the recorded output looks
like it leaked PII through the auto-rules, add a per-CLI override in
`eval-fixtures/.anonymize/<cli>.yaml` and re-record.
```

Also modify the "When to invoke" trigger phrases section to include local
phrasing — append to the bullet list:

```markdown
- "run local evals" / "local eval" / "evals with mocks"
```

And modify the "Standing rules" section by adding a new rule at the end:

```markdown
- **Default to local.** Unless the user explicitly says "deployed eval",
  "real eval", or "against Render", run `--local` mode. Local is faster
  and free; deployed is reserved for confirmation runs.
```

- [ ] **Step 3: Manual verification**

The `.claude/skills/run-evals/SKILL.md` file should now reference
`--local` and the local-mode workflow. No commit (no git repo at
workspace level), but the file is persisted on disk for future
invocations of the skill.

```bash
grep -n "local" /Users/adamharris/Documents/repos/clis/.claude/skills/run-evals/SKILL.md | head -10
```

Expected: hits showing the new local-mode references.

---

## Task 18: Operator README for eval-mocks

**Files:**
- Create: `clis-worker/eval-mocks/README.md`

- [ ] **Step 1: Write the README**

Create `eval-mocks/README.md`:

```markdown
# eval-mocks

Local, MAX-backed eval infrastructure for `clis-worker`. VCR-style
cassettes replace real CLI invocations, so the recipe-tuning loop iterates
without paying Anthropic API or third-party API cost.

See the [design spec](../docs/superpowers/specs/2026-05-11-local-mocked-evals-design.md)
for context.

## Quick start

```bash
# 1. Build the dispatcher and create symlinks
npm run build && npm run eval:setup

# 2. First-time recording (requires real auth in your shell .env)
npm run local-eval -- --mode=record --output=baseline --slug=bootstrap

# 3. Subsequent runs replay from cassettes (free, no API costs)
npm run local-eval -- --output=baseline --slug=experiment-01
# … edit a recipe in clis-worker/docs/addenda/<cli>.md …
npm run local-eval -- --output=after --slug=experiment-01
npm run eval:report -- eval-runs/<today>-experiment-01
```

## Modes

- **replay** (default): cassette hit → serve recording; miss → exit 87,
  `EVAL_MOCK_MISS` in stderr. The eval reporter flags `mock_misses` so
  you don't celebrate a "cost reduction" that's just a tool failing fast.
- **record**: ignore existing cassettes; always exec real CLI; anonymize
  output; persist new cassette overwriting any existing.
- **record-missing**: replay if cassette exists; otherwise act like
  record. Use during dev iteration when recipes start invoking commands
  the cassette dir hasn't seen.

## Cassettes

Stored in `clis-worker/eval-fixtures/<cli>/<slug>__<hash>.json`. Each
cassette has a sibling `<slug>__<hash>.audit.json` listing every
redaction made during recording.

`INDEX.md` (auto-generated by `regenerateIndex` after every record
operation) lists every cassette with its full original command and
recording metadata.

## Anonymization

Two layers (composable):

1. **Global** rules (`eval-fixtures/.anonymize/global.yaml`):
   - `patterns`: regex string-scan over every JSON value (and over raw
     stdout when output isn't JSON).
   - `field_names`: case-insensitive JSON keys whose values get scrubbed
     regardless of CLI.
2. **Per-CLI** rules (`eval-fixtures/.anonymize/<cli>.yaml`):
   - `fields`: JSONPath selectors (`$..foo.bar`, `$.foo[*].bar`,
     recursive descent supported).
   - `env_whitelist`: env vars that affect output and must be part of
     the cassette key.
   - `arg_normalization`: `flag-order-insensitive` (default — sorts
     `--flag value` pairs) or `preserve-order`.
   - `prose_doctor`: if `true`, `doctor` output is treated as prose
     (no JSON parsing; pattern-scan only).

Replacements use `hash(value)[:8]` with a human-readable prefix
(`channel_a4b9c2d1`, `email_3f1e0a82`). Same value always produces the
same fake — reference integrity holds across cassettes for free, no
shared identity-map file needed.

## Adding a new CLI

1. Add the binary name to the `CLIS` array in
   `eval-mocks/scripts/setup-symlinks.ts`.
2. Add `eval-fixtures/.anonymize/<cli>.yaml` with the CLI's fields,
   env_whitelist, and (if doctor is prose) `prose_doctor: true`.
3. Add fake values for any required env vars to `eval-fixtures/.env.eval`.
4. `npm run build && npm run eval:setup` to create the new symlink.
5. Record cassettes for the prompts you care about:
   ```bash
   npm run local-eval -- --mode=record-missing --include <cli> --slug bootstrap
   ```

## Limits and known gaps

- **Schema drift** is not detected. If a real API adds a new field, the
  cassette is missing it. The deployed eval is the integration check.
- **Concurrent record sessions** can race. Single-user assumption.
- **Adversarial PII reconstruction** is not the threat model: the hash
  replacements are deterministic, so anyone with the original value can
  verify it's in a cassette by hashing it themselves. The protection is
  against putting raw client data in git, not against a motivated
  attacker.
- **`doctor` output anonymization** for prose-emitting CLIs is regex-only
  (no JSON parsing). Review the first cassette of each CLI's `doctor`
  output after recording.

## Tests

```bash
npm test                      # unit tests (anonymizer, store, dispatcher, key)
npm run build && npx vitest run eval-mocks/test/integration.test.ts
                              # end-to-end record/replay/miss with fake CLI
npm run local-eval:smoke      # one-prompt tripwire against real worker
```
```

- [ ] **Step 2: Commit**

```bash
git add eval-mocks/README.md
git commit -m "docs(eval): add eval-mocks operator README

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 19: Final verification — full test suite + manual smoke

**No new files; verification only.**

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: all unit and integration tests pass.

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: no type errors.

- [ ] **Step 3: Confirm git status is clean**

```bash
git status
```

Expected: clean working tree, all 18 task commits present:

```bash
git log --oneline | head -20
```

Expected: see 18 commits in reverse chronological order, ending at
"feat(eval): scaffold eval-mocks dirs, deps, scripts, .env.eval".

- [ ] **Step 4: Manual end-to-end check (without recording)**

```bash
# Start the worker manually under mocked PATH, just to confirm it boots.
# This will fail with EVAL_MOCK_MISS for any CLI command, but that's
# the point — we're verifying the orchestration works.
npm run local-eval -- --include hello --slug final-check
```

Expected:
- Worker starts on port 3787, /health returns 200
- "No tool: hello" prompt runs successfully (no CLI invoked)
- Result has `tool_calls=0`, `is_error=false`
- File `eval-runs/<today>-final-check/baseline.json` written

- [ ] **Step 5: Tell the user what's next**

The infrastructure is ready. The next user-facing step (NOT in this plan,
because it requires real auth):

```bash
# One-time: record cassettes for the canonical prompt set
npm run local-eval -- --mode=record --output=baseline --slug=bootstrap

# After that, the recipe-tuning loop is:
npm run local-eval -- --slug=<experiment>          # baseline (replay)
# … edit recipe(s) …
npm run local-eval -- --output=after --slug=<experiment>
npm run eval:report -- eval-runs/<today>-<experiment>
```

---

## Spec coverage check

| Spec section | Implemented in |
|---|---|
| Goals 1–4 | Tasks 1, 4, 5, 6, 9, 14 |
| Architecture diagram | Tasks 8, 10, 13, 14 |
| Components table | Tasks 2 (types), 3 (key), 4–6 (anonymizer), 7 (store), 8–9 (dispatcher), 10 (entrypoint+symlinks), 13–14 (eval-runner), 15 (reporter), 17 (skill) |
| Data flow — replay | Task 8 |
| Data flow — record | Task 9 |
| Env var expansion / .env.eval | Tasks 1, 14 |
| Stdin handling | Task 10 |
| Argv normalization | Task 3 |
| Cassette miss / EXIT 87 | Task 8 |
| Anonymizer fail handling | Task 6 |
| Worker subprocess won't start | Task 13 |
| MAX session unavailable | Tasks 13, 14 (surfaces SDK error) |
| Cassette drift / age warnings | Task 7 (recorded_at + cli_version captured); Task 15 (reporter — currently no age warning emitted, see "Spec gap" below) |
| Unit tests | Tasks 3, 4, 5, 6, 7, 8, 9, 12, 13, 15 |
| Integration test (fake-pp-cli) | Task 11 |
| Smoke test (real worker) | Task 16 |
| Stability check (--samples N) | Task 14 (CLI flag), Task 15 (averaging in `avgByLabel`) |
| Skill `--local` flag, phase changes | Task 17 |
| Comparison report shape | Task 15 |
| Cost discipline / promotion path | Task 17 (skill text) |
| Port collision (EVAL_PORT) | Tasks 13, 14 |

**Spec gap noted:** the spec calls for the reporter to print a warning at
the top of `report.md` if any cassette is >90 days old or recorded
against a different CLI version than installed. The implementation in
Task 15 captures `recorded_at` and `cli_version` in cassettes (Task 7)
but doesn't yet read them at report time to emit the age warning. This
is a YAGNI deferral: the warning is only useful once cassettes are 3+
months old, which won't be true until well after this plan ships. Add
when the first warning would actually fire.
