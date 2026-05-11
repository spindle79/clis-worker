#!/usr/bin/env node
// Top-level orchestrator for `npm run local-eval`. Spawns the worker
// with mocked CLIs on PATH, sends the prompt set serially, writes the
// results to eval-runs/<date>-<slug>/.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startWorker, stopWorker } from "./eval-server.js";
import { loadPrompts, filterPrompts } from "./eval-prompts.js";
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
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) {
        console.error(`missing value for arg: ${a}`);
        process.exit(2);
      }
      return v;
    };
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
