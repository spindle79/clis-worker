import { describe, it, expect } from "vitest";
import { anonymize } from "../src/anonymizer.js";
import type { AnonymizerRules } from "../src/types.js";

const rules: AnonymizerRules = {
  global: {
    patterns: [
      { name: "email", regex: "\\S+@\\S+\\.\\S+", strategy: "hash", prefix: "email_" },
    ],
    field_names: ["display_name"],
  },
  per_cli: {
    "slack-pp-cli": {
      fields: [
        { jsonpath: "$..channel.name", strategy: "hash", prefix: "channel_" },
        { jsonpath: "$..user.id", strategy: "hash", prefix: "user_" },
      ],
      env_whitelist: ["SLACK_BOT_TOKEN"],
      arg_normalization: "flag-order-insensitive",
      doctor_emits_prose: true,
    },
  },
};

describe("anonymize (JSON path)", () => {
  it("scrubs nested fields by jsonpath", () => {
    const out = anonymize({
      cli: "slack-pp-cli",
      output: JSON.stringify({ channels: [{ channel: { name: "general" } }] }),
      rules,
      isJson: true,
    });
    const parsed = JSON.parse(out.output);
    expect(parsed.channels[0].channel.name).toMatch(/^channel_[0-9a-f]{8}$/);
    expect(out.redactions).toHaveLength(1);
    expect(out.redactions[0].rule).toBe("cli:slack-pp-cli:$..channel.name");
  });

  it("preserves reference integrity across multiple paths", () => {
    const out = anonymize({
      cli: "slack-pp-cli",
      output: JSON.stringify({
        users: [
          { user: { id: "U001" }, history: { user: { id: "U001" } } },
          { user: { id: "U002" } },
        ],
      }),
      rules,
      isJson: true,
    });
    const parsed = JSON.parse(out.output);
    expect(parsed.users[0].user.id).toBe(parsed.users[0].history.user.id);
    expect(parsed.users[0].user.id).not.toBe(parsed.users[1].user.id);
  });

  it("scrubs by global field_names list", () => {
    const out = anonymize({
      cli: "slack-pp-cli",
      output: JSON.stringify({ display_name: "Alex Smith", other: "kept" }),
      rules,
      isJson: true,
    });
    const parsed = JSON.parse(out.output);
    expect(parsed.display_name).not.toBe("Alex Smith");
    expect(parsed.other).toBe("kept");
  });

  it("applies global patterns to string values within JSON", () => {
    const out = anonymize({
      cli: "slack-pp-cli",
      output: JSON.stringify({ contact: "Email alice@example.com for help" }),
      rules,
      isJson: true,
    });
    const parsed = JSON.parse(out.output);
    expect(parsed.contact).toMatch(/email_[0-9a-f]{8}/);
    expect(parsed.contact).not.toContain("alice@example.com");
  });

  it("preserves shape: types, null, missing, empty arrays", () => {
    const out = anonymize({
      cli: "slack-pp-cli",
      output: JSON.stringify({
        a: null,
        b: 42,
        c: true,
        d: [],
        e: {},
        nested: { f: null },
      }),
      rules,
      isJson: true,
    });
    expect(JSON.parse(out.output)).toEqual({
      a: null, b: 42, c: true, d: [], e: {}, nested: { f: null },
    });
  });

  it("falls back to pattern-only scan for non-JSON output", () => {
    const out = anonymize({
      cli: "slack-pp-cli",
      output: "auth ok for alice@example.com",
      rules,
      isJson: false,
    });
    expect(out.output).not.toContain("alice@example.com");
    expect(out.notes).toContain("non-JSON: pattern scan only");
  });

  it("handles unknown CLI by skipping per-CLI rules", () => {
    const out = anonymize({
      cli: "unknown-cli",
      output: JSON.stringify({ display_name: "Alex" }),
      rules,
      isJson: true,
    });
    const parsed = JSON.parse(out.output);
    expect(parsed.display_name).not.toBe("Alex"); // global field_names still applies
  });

  it("is idempotent for the redact strategy too", () => {
    const redactRules: AnonymizerRules = {
      global: { patterns: [], field_names: [] },
      per_cli: {
        "slack-pp-cli": {
          fields: [
            { jsonpath: "$..token", strategy: "redact" },
          ],
          env_whitelist: [],
          arg_normalization: "flag-order-insensitive",
          doctor_emits_prose: false,
        },
      },
    };
    const first = anonymize({
      cli: "slack-pp-cli",
      output: JSON.stringify({ token: "secret123" }),
      rules: redactRules,
      isJson: true,
    });
    expect(JSON.parse(first.output).token).toBe("[redacted]");
    expect(first.redactions).toHaveLength(1);

    const second = anonymize({
      cli: "slack-pp-cli",
      output: first.output,
      rules: redactRules,
      isJson: true,
    });
    expect(second.output).toBe(first.output);
    expect(second.redactions).toHaveLength(0);
  });

  it("is idempotent: anonymizing an already-anonymized output is a no-op", () => {
    const first = anonymize({
      cli: "slack-pp-cli",
      output: JSON.stringify({ channel: { name: "general" } }),
      rules,
      isJson: true,
    });
    const second = anonymize({
      cli: "slack-pp-cli",
      output: first.output,
      rules,
      isJson: true,
    });
    expect(second.output).toBe(first.output);
    expect(second.redactions).toHaveLength(0);
  });
});
