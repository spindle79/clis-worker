import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { PromptResult } from "./eval-runner.js";

export interface CompareRow {
  label: string;
  category: string;
  turns_before: number | null;
  turns_after: number | null;
  delta_turns: number | null;
  tool_calls_before: number | null;
  tool_calls_after: number | null;
  delta_tool_calls: number | null;
  duration_before: number | null;
  duration_after: number | null;
  delta_duration: number | null;
  mock_misses_before: number;
  mock_misses_after: number;
  status: "OK" | "NO CHANGE" | "DEGRADED" | "MISSING" | "ERROR";
  regressed: boolean;
}

export interface CompareResult {
  rows: CompareRow[];
  aggregates: {
    prompts: number;
    total_turns_before: number;
    total_turns_after: number;
    delta_turns: number;
    pct_turns: number;
    total_tool_calls_before: number;
    total_tool_calls_after: number;
    delta_tool_calls: number;
    pct_tool_calls: number;
    regressions: number;
    mock_misses_after: number;
  };
}

function avgByLabel(results: PromptResult[]): Map<string, PromptResult> {
  // When --samples > 1, multiple results per label exist. Average the
  // numerics; keep the label/category from the first one.
  const groups = new Map<string, PromptResult[]>();
  for (const r of results) {
    const arr = groups.get(r.label) ?? [];
    arr.push(r);
    groups.set(r.label, arr);
  }
  const out = new Map<string, PromptResult>();
  for (const [label, arr] of groups) {
    const avg = (key: keyof PromptResult): number | undefined => {
      const vs = arr.map((r) => r[key] as number).filter((n) => typeof n === "number");
      if (vs.length === 0) return undefined;
      return vs.reduce((a, b) => a + b, 0) / vs.length;
    };
    out.set(label, {
      category: arr[0]!.category,
      label,
      prompt: arr[0]!.prompt,
      num_turns: avg("num_turns"),
      tool_calls: avg("tool_calls"),
      duration_ms: avg("duration_ms"),
      mock_misses: arr.reduce((a, r) => a + (r.mock_misses ?? 0), 0),
      is_error: arr.some((r) => r.is_error),
    });
  }
  return out;
}

export function compare(baseline: PromptResult[], after: PromptResult[]): CompareResult {
  const b = avgByLabel(baseline);
  const a = avgByLabel(after);
  const labels = new Set([...b.keys(), ...a.keys()]);

  const rows: CompareRow[] = [];
  for (const label of labels) {
    const bi = b.get(label);
    const ai = a.get(label);
    const turnsB = bi?.num_turns ?? null;
    const turnsA = ai?.num_turns ?? null;
    const toolsB = bi?.tool_calls ?? null;
    const toolsA = ai?.tool_calls ?? null;
    const durB = bi?.duration_ms ?? null;
    const durA = ai?.duration_ms ?? null;
    const dT = (turnsA != null && turnsB != null) ? Math.round((turnsA - turnsB) * 10) / 10 : null;
    const dC = (toolsA != null && toolsB != null) ? Math.round((toolsA - toolsB) * 10) / 10 : null;
    const dD = (durA != null && durB != null) ? Math.round(durA - durB) : null;
    const missB = bi?.mock_misses ?? 0;
    const missA = ai?.mock_misses ?? 0;

    let status: CompareRow["status"] = "OK";
    let regressed = false;
    if (!bi || !ai) status = "MISSING";
    else if (bi.is_error || ai.is_error) status = "ERROR";
    else if (missA > missB) { status = "DEGRADED"; }
    else if ((dT ?? 0) === 0 && (dC ?? 0) === 0) status = "NO CHANGE";
    if ((dT ?? 0) > 0 || (dC ?? 0) > 0) regressed = true;

    rows.push({
      label,
      category: (bi ?? ai)!.category,
      turns_before: turnsB, turns_after: turnsA, delta_turns: dT,
      tool_calls_before: toolsB, tool_calls_after: toolsA, delta_tool_calls: dC,
      duration_before: durB, duration_after: durA, delta_duration: dD,
      mock_misses_before: missB, mock_misses_after: missA,
      status, regressed,
    });
  }

  const sum = (key: keyof CompareRow): number =>
    rows.reduce((s, r) => s + ((r[key] as number) ?? 0), 0);

  const totalTurnsB = sum("turns_before");
  const totalTurnsA = sum("turns_after");
  const totalToolsB = sum("tool_calls_before");
  const totalToolsA = sum("tool_calls_after");

  return {
    rows: rows.sort((x, y) => x.label.localeCompare(y.label)),
    aggregates: {
      prompts: rows.length,
      total_turns_before: totalTurnsB,
      total_turns_after: totalTurnsA,
      delta_turns: totalTurnsA - totalTurnsB,
      pct_turns: totalTurnsB > 0 ? Math.round(((totalTurnsA - totalTurnsB) / totalTurnsB) * 100) : 0,
      total_tool_calls_before: totalToolsB,
      total_tool_calls_after: totalToolsA,
      delta_tool_calls: totalToolsA - totalToolsB,
      pct_tool_calls: totalToolsB > 0 ? Math.round(((totalToolsA - totalToolsB) / totalToolsB) * 100) : 0,
      regressions: rows.filter((r) => r.regressed).length,
      mock_misses_after: sum("mock_misses_after"),
    },
  };
}

export function formatReport(cmp: CompareResult, opts: { samplesPerPrompt: number }): string {
  let md = `# Local eval comparison\n\n`;
  md += `Generated: ${new Date().toISOString()}\n`;
  md += `Samples per prompt: ${opts.samplesPerPrompt}\n\n`;

  md += `| prompt | turns (b→a, Δ) | tool_calls (b→a, Δ) | duration ms (b→a) | misses (b→a) | status |\n`;
  md += `|---|---|---|---|---|---|\n`;
  for (const r of cmp.rows) {
    const turns = `${r.turns_before ?? "?"} → ${r.turns_after ?? "?"} (${r.delta_turns ?? "?"})`;
    const tools = `${r.tool_calls_before ?? "?"} → ${r.tool_calls_after ?? "?"} (${r.delta_tool_calls ?? "?"})`;
    const dur = `${r.duration_before ?? "?"} → ${r.duration_after ?? "?"}`;
    const miss = `${r.mock_misses_before} → ${r.mock_misses_after}`;
    md += `| ${r.label} | ${turns} | ${tools} | ${dur} | ${miss} | ${r.status}${r.regressed ? " ✗" : ""} |\n`;
  }

  const a = cmp.aggregates;
  md += `\n## Aggregates\n\n`;
  md += `- Prompts: ${a.prompts}\n`;
  md += `- Turns: ${a.total_turns_before} → ${a.total_turns_after} (${a.delta_turns >= 0 ? "+" : ""}${a.delta_turns}, ${a.pct_turns}%)\n`;
  md += `- Tool calls: ${a.total_tool_calls_before} → ${a.total_tool_calls_after} (${a.delta_tool_calls >= 0 ? "+" : ""}${a.delta_tool_calls}, ${a.pct_tool_calls}%)\n`;
  md += `- Regressions: ${a.regressions}\n`;
  md += `- Mock misses (after): ${a.mock_misses_after}\n`;
  if (opts.samplesPerPrompt === 1) {
    md += `\n_Note: --samples=1. Turn counts have ±1–2 LLM-noise; re-run with --samples 3 to confirm._\n`;
  }
  return md;
}

// CLI mode: `npm run eval:report -- <run-dir>`
async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) {
    console.error("Usage: npm run eval:report -- <eval-runs/<date>-<slug>>");
    process.exit(2);
  }
  const baseline = path.join(dir, "baseline.json");
  const after = path.join(dir, "after.json");
  if (!existsSync(baseline) || !existsSync(after)) {
    console.error(`Need both baseline.json and after.json in ${dir}`);
    process.exit(2);
  }
  const b = JSON.parse(readFileSync(baseline, "utf8"));
  const a = JSON.parse(readFileSync(after, "utf8"));
  const cmp = compare(b.results, a.results);
  const md = formatReport(cmp, { samplesPerPrompt: b.args?.samples ?? 1 });
  const out = path.join(dir, "report.md");
  writeFileSync(out, md);
  console.log(`Wrote ${out}`);
  console.log(md);
}

// CLI entrypoint detection. We need to avoid running main() during vitest
// imports. Check if argv[1] ends with eval-report.{ts,js}.
const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("eval-report.ts") || entryPath.endsWith("eval-report.js")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
