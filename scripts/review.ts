/**
 * Surface high-cost / high-turn agent runs from the worker's transcript log.
 *
 * Usage (run from clis-worker/):
 *   WORKER_URL=https://clis-worker.onrender.com WORKER_API_KEY=... npx tsx scripts/review.ts
 *   WORKER_URL=http://localhost:3000 npx tsx scripts/review.ts
 *
 * Flags (env vars):
 *   WORKER_URL       — base URL of the worker (defaults to local)
 *   WORKER_API_KEY   — bearer token if the worker requires auth
 *   LIMIT            — max transcripts to fetch (default 50)
 *   SHOW             — how many outliers to print per category (default 10)
 *   MIN_TURNS        — only flag runs with at least this many turns (default 5)
 *   MIN_COST         — only flag runs costing at least this many USD (default 0.04)
 */

type Summary = {
  date: string;
  file: string;
  ts: number;
  session_id?: string;
  model?: string;
  prompt?: string;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  is_error?: boolean;
  stop_reason?: string;
};

const baseUrl = process.env.WORKER_URL ?? "http://localhost:3000";
const token = process.env.WORKER_API_KEY ?? "";
const limit = Number(process.env.LIMIT ?? 50);
const show = Number(process.env.SHOW ?? 10);
const minTurns = Number(process.env.MIN_TURNS ?? 5);
const minCost = Number(process.env.MIN_COST ?? 0.04);

async function main() {
  const url = new URL(`/transcripts?limit=${limit}`, baseUrl).toString();
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`HTTP ${res.status}: ${body || res.statusText}`);
    process.exit(1);
  }
  const { transcripts } = (await res.json()) as { transcripts: Summary[] };
  if (!transcripts || transcripts.length === 0) {
    console.log("no transcripts yet");
    return;
  }

  const total = transcripts.length;
  const totalCost = transcripts.reduce(
    (s, t) => s + (t.total_cost_usd ?? 0),
    0,
  );
  const totalTurns = transcripts.reduce((s, t) => s + (t.num_turns ?? 0), 0);
  const errs = transcripts.filter((t) => t.is_error).length;

  console.log("");
  console.log(
    `Reviewed ${total} transcript${total === 1 ? "" : "s"} from ${baseUrl}`,
  );
  console.log(
    `total cost: $${totalCost.toFixed(4)}   total turns: ${totalTurns}   errors: ${errs}`,
  );
  console.log("");

  const byCost = [...transcripts]
    .filter((t) => (t.total_cost_usd ?? 0) >= minCost)
    .sort((a, b) => (b.total_cost_usd ?? 0) - (a.total_cost_usd ?? 0))
    .slice(0, show);

  const byTurns = [...transcripts]
    .filter((t) => (t.num_turns ?? 0) >= minTurns)
    .sort((a, b) => (b.num_turns ?? 0) - (a.num_turns ?? 0))
    .slice(0, show);

  printSection(`Most expensive (>= $${minCost.toFixed(2)})`, byCost);
  printSection(`Highest turn count (>= ${minTurns})`, byTurns);

  const errorRuns = transcripts.filter((t) => t.is_error).slice(0, show);
  if (errorRuns.length > 0) {
    printSection("Errors", errorRuns);
  }
}

function printSection(title: string, rows: Summary[]) {
  console.log(`== ${title} ==`);
  if (rows.length === 0) {
    console.log("  (none)");
    console.log("");
    return;
  }
  for (const r of rows) {
    const cost =
      r.total_cost_usd !== undefined
        ? `$${r.total_cost_usd.toFixed(4)}`
        : "    -   ";
    const turns = r.num_turns ?? "?";
    const secs =
      r.duration_ms !== undefined
        ? `${(r.duration_ms / 1000).toFixed(1)}s`
        : "  - ";
    const promptPreview = (r.prompt ?? "").replace(/\s+/g, " ").slice(0, 70);
    const errFlag = r.is_error ? " [ERR]" : "";
    console.log(
      `  ${cost}  ${String(turns).padStart(3)}t  ${secs.padStart(6)}  ${r.date}/${r.file}${errFlag}`,
    );
    console.log(`        "${promptPreview}"`);
  }
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
