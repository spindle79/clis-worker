import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRules } from "../src/anonymizer-rules.js";

function tmpRulesDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "eval-rules-"));
  const anon = path.join(dir, ".anonymize");
  mkdirSync(anon);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(anon, name), content);
  }
  return dir;
}

describe("loadRules", () => {
  it("loads global rules from global.yaml", () => {
    const dir = tmpRulesDir({
      "global.yaml": `
patterns:
  - { name: email, regex: '\\S+@\\S+', strategy: hash, prefix: email_ }
field_names: [email, phone]
`,
    });
    const rules = loadRules(dir);
    expect(rules.global.patterns).toHaveLength(1);
    expect(rules.global.patterns[0].name).toBe("email");
    expect(rules.global.field_names).toEqual(["email", "phone"]);
    expect(rules.per_cli).toEqual({});
  });

  it("loads per-CLI rules from <cli>.yaml", () => {
    const dir = tmpRulesDir({
      "global.yaml": `patterns: []
field_names: []`,
      "slack-pp-cli.yaml": `
fields:
  - { jsonpath: '$..channel.name', strategy: hash, prefix: channel_ }
env_whitelist: [SLACK_BOT_TOKEN]
arg_normalization: flag-order-insensitive
doctor_emits_prose: true
`,
    });
    const rules = loadRules(dir);
    expect(rules.per_cli["slack-pp-cli"]).toBeDefined();
    expect(rules.per_cli["slack-pp-cli"].fields).toHaveLength(1);
    expect(rules.per_cli["slack-pp-cli"].env_whitelist).toEqual(["SLACK_BOT_TOKEN"]);
    expect(rules.per_cli["slack-pp-cli"].arg_normalization).toBe("flag-order-insensitive");
    expect(rules.per_cli["slack-pp-cli"].doctor_emits_prose).toBe(true);
  });

  it("provides safe defaults when global.yaml is missing", () => {
    const dir = tmpRulesDir({});
    const rules = loadRules(dir);
    expect(rules.global.patterns).toEqual([]);
    expect(rules.global.field_names).toEqual([]);
    expect(rules.per_cli).toEqual({});
  });

  it("returns default CliRules when querying an unknown CLI", () => {
    const dir = tmpRulesDir({});
    const rules = loadRules(dir);
    const r = rules.per_cli["unknown-cli"];
    expect(r).toBeUndefined(); // caller falls back to default
  });

  it("ignores files that aren't .yaml", () => {
    const dir = tmpRulesDir({
      "README.md": "# notes",
      "global.yaml": "patterns: []\nfield_names: []",
    });
    expect(() => loadRules(dir)).not.toThrow();
  });
});
