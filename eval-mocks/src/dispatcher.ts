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
  if (cliRules.doctor_emits_prose && argv[0] === "doctor") return false;
  const trimmed = stdout.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

export async function dispatch(opts: DispatchOptions): Promise<number> {
  let mode: MockMode;
  try {
    mode = getMode(opts.env);
  } catch (err) {
    opts.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }

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
