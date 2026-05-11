import { describe, it, expect } from "vitest";
import { startWorker, stopWorker } from "../eval-server.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

describe("startWorker / stopWorker", () => {
  it("spawns the worker, polls /health, and stops cleanly", async () => {
    const handle = await startWorker({
      port: 4789,
      env: {
        EVAL_MOCK_MODE: "replay",
        EVAL_FIXTURE_DIR: path.join(repoRoot, "eval-fixtures"),
        EVAL_MOCK_BIN_DIR: path.join(repoRoot, "eval-mocks/bin"),
        WORKER_API_KEY: "",
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
      env: {},
      cwd: "/tmp",  // wrong cwd; tsx won't find src/server.ts
      timeoutMs: 5_000,
    })).rejects.toThrow(/health.*did not respond|spawn.*failed|exited/i);
  }, 15_000);
});
