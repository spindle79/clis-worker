import { describe, it, expect } from "vitest";
import { normalizeArgv, slugify, computeKey } from "../src/key.js";

describe("normalizeArgv", () => {
  it("preserves positional argument order", () => {
    expect(normalizeArgv(["channels", "list"], "flag-order-insensitive"))
      .toEqual(["channels", "list"]);
  });

  it("sorts --flag value pairs alphabetically", () => {
    const a = normalizeArgv(
      ["channels", "list", "--limit", "10", "--filter", "is_member"],
      "flag-order-insensitive",
    );
    const b = normalizeArgv(
      ["channels", "list", "--filter", "is_member", "--limit", "10"],
      "flag-order-insensitive",
    );
    expect(a).toEqual(b);
  });

  it("normalizes --flag=value to --flag value", () => {
    const a = normalizeArgv(["x", "--limit=10"], "flag-order-insensitive");
    const b = normalizeArgv(["x", "--limit", "10"], "flag-order-insensitive");
    expect(a).toEqual(b);
  });

  it("preserves order in preserve-order mode", () => {
    const a = normalizeArgv(["x", "--b", "1", "--a", "2"], "preserve-order");
    expect(a).toEqual(["x", "--b", "1", "--a", "2"]);
  });

  it("preserves repeated flags as ordered", () => {
    const a = normalizeArgv(
      ["x", "--include", "a", "--include", "b"],
      "flag-order-insensitive",
    );
    expect(a).toEqual(["x", "--include", "a", "--include", "b"]);
  });

  it("treats boolean flags (no value) as flags", () => {
    const a = normalizeArgv(["x", "--verbose", "--limit", "10"], "flag-order-insensitive");
    const b = normalizeArgv(["x", "--limit", "10", "--verbose"], "flag-order-insensitive");
    expect(a).toEqual(b);
  });
});

describe("slugify", () => {
  it("joins first 5 args with dashes", () => {
    expect(slugify(["channels", "list", "--agent"])).toBe("channels-list--agent");
  });

  it("truncates beyond 5 args", () => {
    const argv = ["a", "b", "c", "d", "e", "f", "g"];
    expect(slugify(argv)).toBe("a-b-c-d-e");
  });

  it("strips characters unsafe for filesystems", () => {
    expect(slugify(["path/with/slash", "name with space"]))
      .toBe("pathwithslash-namewithspace");
  });

  it("collapses consecutive dashes", () => {
    expect(slugify(["a", "", "b"])).toBe("a-b");
  });
});

describe("computeKey", () => {
  it("produces a stable 8-char hash for identical inputs", () => {
    const k = computeKey({
      cli: "slack-pp-cli",
      argv: ["channels", "list", "--agent"],
      stdin: "",
      env: { SLACK_BOT_TOKEN: "x" },
      envWhitelist: ["SLACK_BOT_TOKEN"],
      normalizeArgs: "flag-order-insensitive",
    });
    expect(k.cli).toBe("slack-pp-cli");
    expect(k.slug).toBe("channels-list--agent");
    expect(k.hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("returns the same key when only flag order differs", () => {
    const a = computeKey({
      cli: "x", argv: ["go", "--a", "1", "--b", "2"], stdin: "",
      env: {}, envWhitelist: [], normalizeArgs: "flag-order-insensitive",
    });
    const b = computeKey({
      cli: "x", argv: ["go", "--b", "2", "--a", "1"], stdin: "",
      env: {}, envWhitelist: [], normalizeArgs: "flag-order-insensitive",
    });
    expect(a.hash).toBe(b.hash);
  });

  it("returns different keys when stdin differs", () => {
    const a = computeKey({
      cli: "x", argv: ["go"], stdin: "{}",
      env: {}, envWhitelist: [], normalizeArgs: "flag-order-insensitive",
    });
    const b = computeKey({
      cli: "x", argv: ["go"], stdin: '{"a":1}',
      env: {}, envWhitelist: [], normalizeArgs: "flag-order-insensitive",
    });
    expect(a.hash).not.toBe(b.hash);
  });

  it("ignores env vars not in whitelist", () => {
    const a = computeKey({
      cli: "x", argv: ["go"], stdin: "",
      env: { PATH: "/a", SLACK_BOT_TOKEN: "x" }, envWhitelist: ["SLACK_BOT_TOKEN"],
      normalizeArgs: "flag-order-insensitive",
    });
    const b = computeKey({
      cli: "x", argv: ["go"], stdin: "",
      env: { PATH: "/b", SLACK_BOT_TOKEN: "x" }, envWhitelist: ["SLACK_BOT_TOKEN"],
      normalizeArgs: "flag-order-insensitive",
    });
    expect(a.hash).toBe(b.hash);
  });
});
