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

  // Bootstrap dependency: cassettes for slack-pp-cli must exist.
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
