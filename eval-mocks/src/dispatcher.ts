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
