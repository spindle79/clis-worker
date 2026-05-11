import { describe, it, expect } from "vitest";
import { applyPatterns, hashReplacement } from "../src/anonymizer-patterns.js";

describe("hashReplacement", () => {
  it("is deterministic for the same input", () => {
    expect(hashReplacement("alice@example.com", "email_"))
      .toBe(hashReplacement("alice@example.com", "email_"));
  });

  it("differs between values", () => {
    expect(hashReplacement("alice@example.com", "email_"))
      .not.toBe(hashReplacement("bob@example.com", "email_"));
  });

  it("preserves the prefix", () => {
    expect(hashReplacement("x", "user_")).toMatch(/^user_[0-9a-f]{8}$/);
  });
});

describe("applyPatterns", () => {
  const patterns = [
    {
      name: "email",
      regex: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",
      strategy: "hash" as const,
      prefix: "email_",
    },
  ];

  it("replaces all matches in a string", () => {
    const r = applyPatterns("contact alice@example.com or bob@x.io", patterns);
    expect(r.text).not.toContain("alice@example.com");
    expect(r.text).not.toContain("bob@x.io");
    expect(r.text).toMatch(/email_[0-9a-f]{8}/g);
    expect(r.redactions).toHaveLength(2);
  });

  it("uses the same replacement for the same value (reference integrity)", () => {
    const r = applyPatterns("alice@x.io and again alice@x.io", patterns);
    const matches = r.text.match(/email_[0-9a-f]{8}/g)!;
    expect(matches[0]).toBe(matches[1]);
  });

  it("returns the original text and no redactions when no patterns match", () => {
    const r = applyPatterns("hello world", patterns);
    expect(r.text).toBe("hello world");
    expect(r.redactions).toEqual([]);
  });

  it("records each replacement in the audit", () => {
    const r = applyPatterns("a@b.io", patterns);
    expect(r.redactions[0].rule).toBe("global:email");
    expect(r.redactions[0].replacement).toMatch(/^email_[0-9a-f]{8}$/);
    expect(r.redactions[0].original_hash).toMatch(/^[0-9a-f]{8}$/);
  });
});
