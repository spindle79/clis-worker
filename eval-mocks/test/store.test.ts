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
