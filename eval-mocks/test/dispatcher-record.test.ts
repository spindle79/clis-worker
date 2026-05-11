import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dispatch } from "../src/dispatcher.js";
import { computeKey } from "../src/key.js";
import { cassettePath, auditPath } from "../src/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    `fields: []\nenv_whitelist: []\narg_normalization: flag-order-insensitive\ndoctor_emits_prose: false\n`,
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
    expect(stdoutChunks.join("")).not.toContain("alice@example.com");
    expect(stdoutChunks.join("")).toMatch(/email_[0-9a-f]{8}/);

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
