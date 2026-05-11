import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, renameSync, copyFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const fakeCli = path.join(repoRoot, "eval-mocks/test/fixtures/fake-pp-cli");

let fixtureDir: string;
let mockBinDir: string;
let dispatcherTarget: string;
let perTestFakeCli: string;

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
    "fields: []\nenv_whitelist: []\narg_normalization: flag-order-insensitive\ndoctor_emits_prose: false\n",
  );

  // Per-test bin dir with one symlink pretending to be fake-pp-cli
  mockBinDir = mkdtempSync(path.join(tmpdir(), "eval-bin-"));
  spawnSync("ln", ["-s", dispatcherTarget, path.join(mockBinDir, "fake-pp-cli")]);

  // Copy the shared fake-pp-cli into a per-test path so we can rename it
  // without affecting parallel test files (dispatcher-record.test.ts also uses it).
  perTestFakeCli = path.join(mockBinDir, "real-fake-pp-cli");
  copyFileSync(fakeCli, perTestFakeCli);
  chmodSync(perTestFakeCli, 0o755);
});

function runDispatcher(argv: string[], mode: string): { stdout: string; stderr: string; code: number } {
  const linkPath = path.join(mockBinDir, "fake-pp-cli");
  const out = spawnSync("node", [linkPath, ...argv], {
    env: {
      ...process.env,
      EVAL_MOCK_MODE: mode,
      EVAL_FIXTURE_DIR: fixtureDir,
      EVAL_REAL_CLI_PATH: perTestFakeCli,
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

    // Move the per-test copy out of the way to prove replay isn't shelling out.
    // We rename the copy (not the shared fakeCli) to avoid racing with parallel test files.
    const moved = `${perTestFakeCli}.moved`;
    renameSync(perTestFakeCli, moved);
    try {
      const rep = runDispatcher(["json"], "replay");
      expect(rep.code).toBe(0);
      expect(rep.stdout).toBe(rec.stdout);
    } finally {
      renameSync(moved, perTestFakeCli);
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
