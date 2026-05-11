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

  // Build the env: inherit process.env (so PATH, NODE_PATH etc. are available),
  // then overlay caller's env, stripping undefined values.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  for (const [k, v] of Object.entries(opts.env)) {
    if (v !== undefined) env[k] = v;
    else delete env[k];
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

  proc.stdout?.on("data", () => { /* swallow stdout */ });
  proc.stderr?.on("data", (chunk) => stderrLog.write(chunk));

  // Use object wrappers so TypeScript control-flow narrowing doesn't collapse
  // the types to `never` inside async-boundary if-checks.
  const state: {
    exitedEarly: { code: number | null; signal: NodeJS.Signals | null } | null;
    spawnError: Error | null;
  } = { exitedEarly: null, spawnError: null };

  proc.on("error", (err) => {
    state.spawnError = err;
    stderrLog.end();
  });

  proc.on("exit", (code, signal) => {
    state.exitedEarly = { code, signal };
    stderrLog.end();
  });

  // Brief initial sleep so synchronous spawn errors can be captured.
  await sleep(50);

  const url = `http://localhost:${opts.port}`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { spawnError, exitedEarly } = state;
    if (spawnError) {
      throw new Error(
        `spawn failed: ${spawnError.message}. See ${stderrLogPath}`,
      );
    }
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
