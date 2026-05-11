import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPrompts, filterPrompts } from "../eval-prompts.js";

describe("loadPrompts", () => {
  it("loads from a JSON file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eval-p-"));
    const file = path.join(dir, "prompts.json");
    writeFileSync(file, JSON.stringify([
      { category: "doctor", label: "x", prompt: "say hi" },
      { category: "task", label: "y", prompt: "do it" },
    ]));
    const prompts = loadPrompts(file);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]!.label).toBe("x");
  });

  it("throws on missing file with a helpful error", () => {
    expect(() => loadPrompts("/nonexistent.json"))
      .toThrow(/prompts file not found/);
  });

  it("throws on invalid JSON shape", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eval-p-"));
    const file = path.join(dir, "bad.json");
    writeFileSync(file, JSON.stringify({ not: "an array" }));
    expect(() => loadPrompts(file)).toThrow(/expected an array/);
  });
});

describe("filterPrompts", () => {
  const all = [
    { category: "doctor", label: "slack doctor", prompt: "..." },
    { category: "doctor", label: "ga4 doctor", prompt: "..." },
    { category: "task", label: "Slack: list channels", prompt: "..." },
    { category: "task", label: "No tool: hello", prompt: "..." },
  ];

  it("returns all when no filter", () => {
    expect(filterPrompts(all, {})).toEqual(all);
  });

  it("filters by label substring", () => {
    expect(filterPrompts(all, { include: ["slack"] })).toHaveLength(2);
  });

  it("excludes by label substring", () => {
    expect(filterPrompts(all, { exclude: ["No tool"] })).toHaveLength(3);
  });

  it("filters by category", () => {
    expect(filterPrompts(all, { categories: ["doctor"] })).toHaveLength(2);
  });

  it("composes include + exclude + categories", () => {
    const r = filterPrompts(all, { include: ["slack"], categories: ["doctor"] });
    expect(r).toHaveLength(1);
    expect(r[0]!.label).toBe("slack doctor");
  });
});
