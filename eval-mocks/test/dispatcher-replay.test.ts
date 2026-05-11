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
    const stdoutCapture: string[] = [];
    const stderrCapture: string[] = [];

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
