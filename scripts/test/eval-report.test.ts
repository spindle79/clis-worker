import { describe, it, expect } from "vitest";
import { compare, formatReport } from "../eval-report.js";
import type { PromptResult } from "../eval-runner.js";

const baseline: PromptResult[] = [
  { category: "task", label: "A", prompt: "...", num_turns: 8, tool_calls: 4, duration_ms: 12000, is_error: false, mock_misses: 0 },
  { category: "task", label: "B", prompt: "...", num_turns: 14, tool_calls: 11, duration_ms: 31000, is_error: false, mock_misses: 0 },
  { category: "task", label: "C", prompt: "...", num_turns: 9, tool_calls: 5, duration_ms: 18000, is_error: false, mock_misses: 0 },
];

const after: PromptResult[] = [
  { category: "task", label: "A", prompt: "...", num_turns: 5, tool_calls: 2, duration_ms: 7000, is_error: false, mock_misses: 0 },
  { category: "task", label: "B", prompt: "...", num_turns: 14, tool_calls: 11, duration_ms: 30000, is_error: false, mock_misses: 0 },
  { category: "task", label: "C", prompt: "...", num_turns: 12, tool_calls: 8, duration_ms: 26000, is_error: false, mock_misses: 1 },
];

describe("compare", () => {
  it("computes per-prompt deltas", () => {
    const cmp = compare(baseline, after);
    expect(cmp.rows).toHaveLength(3);
    const a = cmp.rows.find((r) => r.label === "A")!;
    expect(a.delta_turns).toBe(-3);
    expect(a.delta_tool_calls).toBe(-2);
    expect(a.status).toBe("OK");
  });

  it("flags mock-miss-degraded rows", () => {
    const cmp = compare(baseline, after);
    const c = cmp.rows.find((r) => r.label === "C")!;
    expect(c.status).toBe("DEGRADED");
  });

  it("flags regressions in turns or tool_calls", () => {
    const cmp = compare(baseline, after);
    const c = cmp.rows.find((r) => r.label === "C")!;
    expect(c.regressed).toBe(true);
  });

  it("computes aggregates", () => {
    const cmp = compare(baseline, after);
    expect(cmp.aggregates.total_turns_before).toBe(31);
    expect(cmp.aggregates.total_turns_after).toBe(31);
    expect(cmp.aggregates.regressions).toBe(1);
    expect(cmp.aggregates.mock_misses_after).toBe(1);
  });
});

describe("formatReport", () => {
  it("emits a markdown report containing each prompt and aggregates", () => {
    const cmp = compare(baseline, after);
    const md = formatReport(cmp, { samplesPerPrompt: 1 });
    expect(md).toContain("| A |");
    expect(md).toContain("| B |");
    expect(md).toContain("| C |");
    expect(md).toContain("DEGRADED");
    expect(md).toContain("Aggregates");
    expect(md).not.toContain("$cost");  // no cost in local mode
  });
});
