import { serve } from "@hono/node-server";
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { streamText } from "hono/streaming";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  createWriteStream,
  mkdirSync,
  type WriteStream,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.PRESS_DATA_DIR ?? "/data";
const TRANSCRIPTS_DIR = path.join(DATA_DIR, "transcripts");
const WORKER_API_KEY = process.env.WORKER_API_KEY;
const MODEL = process.env.AGENT_MODEL ?? "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You are an agent with access to printing-press CLIs installed on PATH.

Each CLI has its own reference doc at /app/docs/<name>.md. Before
invoking commands from a CLI you don't already have docs for in this
turn, load the reference:

  cat /app/docs/<name>.md

If you're unsure which CLI fits the task, start with:

  cat /app/docs/README.md

\`jq\` and \`python3\` are available for JSON post-processing. Always
pass --agent on commands for compact JSON output. Run '<cli> doctor'
first if you suspect auth, scope, or local-store issues. The local
SQLite store is at $PRESS_DATA_DIR — use 'sync' to populate it and
'search'/'sql' to query without hitting the live API.

Be concise. Return the answer the caller asked for, not a play-by-play
of your tool calls.`;

const app = new Hono();

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return origin;
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return origin;
      }
      return null;
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["authorization", "content-type"],
    maxAge: 600,
  }),
);

const requireAuth: MiddlewareHandler = async (c, next) => {
  if (!WORKER_API_KEY) return next();
  const auth = c.req.header("authorization");
  if (auth !== `Bearer ${WORKER_API_KEY}`) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
};

app.get("/", (c) => c.text("clis-worker ready"));

app.get("/health", (c) =>
  c.json({
    ok: true,
    model: MODEL,
    dataDir: DATA_DIR,
    hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
    hasScrapeCreatorsKey: Boolean(process.env.SCRAPE_CREATORS_API_KEY_AUTH),
    hasSlackKey: Boolean(process.env.SLACK_BOT_TOKEN),
    hasContentfulKey: Boolean(process.env.CONTENTFUL_MANAGEMENT_TOKEN),
    hasContentfulSpace: Boolean(process.env.CONTENTFUL_SPACE_ID),
    hasGa4Credentials: Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS),
    hasGa4PropertyId: Boolean(process.env.GA_PROPERTY_ID),
  }),
);

function openTranscriptLog(prompt: string): {
  write: (line: string) => void;
  close: () => void;
} {
  let stream: WriteStream | null = null;
  try {
    const ts = Date.now();
    const day = new Date(ts).toISOString().slice(0, 10);
    const dayDir = path.join(TRANSCRIPTS_DIR, day);
    mkdirSync(dayDir, { recursive: true });
    stream = createWriteStream(path.join(dayDir, `${ts}.jsonl`));
    stream.write(
      JSON.stringify({
        type: "system",
        subtype: "user_prompt",
        prompt,
        timestamp: new Date(ts).toISOString(),
      }) + "\n",
    );
  } catch (err) {
    console.warn("transcript log: failed to open file:", err);
    stream = null;
  }
  return {
    write: (line) => {
      if (!stream) return;
      try {
        stream.write(line + "\n");
      } catch {
        // best-effort; ignore
      }
    },
    close: () => stream?.end(),
  };
}

app.post("/agent", requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { prompt?: string };
  const prompt = body.prompt;
  if (!prompt) return c.json({ error: "prompt required" }, 400);

  return streamText(c, async (stream) => {
    const log = openTranscriptLog(prompt);

    const events = query({
      prompt,
      options: {
        cwd: DATA_DIR,
        allowedTools: ["Bash"],
        systemPrompt: SYSTEM_PROMPT,
        model: MODEL,
      },
    });

    try {
      for await (const event of events) {
        const line = JSON.stringify(event);
        log.write(line);
        await stream.writeln(line);
      }
    } finally {
      log.close();
    }
  });
});

const TRANSCRIPT_FILE_RE = /^\d+\.jsonl$/;
const DAY_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

type TranscriptSummary = {
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

async function summarizeTranscript(
  date: string,
  file: string,
): Promise<TranscriptSummary | null> {
  try {
    const contents = await readFile(
      path.join(TRANSCRIPTS_DIR, date, file),
      "utf-8",
    );
    const lines = contents.trim().split("\n");
    let prompt: string | undefined;
    let init: { session_id?: string; model?: string } | undefined;
    let result:
      | {
          num_turns?: number;
          duration_ms?: number;
          total_cost_usd?: number;
          is_error?: boolean;
          stop_reason?: string;
        }
      | undefined;
    for (const raw of lines) {
      if (!raw) continue;
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (evt.type === "system" && evt.subtype === "user_prompt") {
        prompt = typeof evt.prompt === "string" ? evt.prompt : undefined;
      } else if (evt.type === "system" && evt.subtype === "init") {
        init = {
          session_id:
            typeof evt.session_id === "string" ? evt.session_id : undefined,
          model: typeof evt.model === "string" ? evt.model : undefined,
        };
      } else if (evt.type === "result") {
        result = {
          num_turns:
            typeof evt.num_turns === "number" ? evt.num_turns : undefined,
          duration_ms:
            typeof evt.duration_ms === "number" ? evt.duration_ms : undefined,
          total_cost_usd:
            typeof evt.total_cost_usd === "number"
              ? evt.total_cost_usd
              : undefined,
          is_error:
            typeof evt.is_error === "boolean" ? evt.is_error : undefined,
          stop_reason:
            typeof evt.stop_reason === "string" ? evt.stop_reason : undefined,
        };
      }
    }
    const ts = Number(file.replace(/\.jsonl$/, ""));
    return {
      date,
      file,
      ts: Number.isFinite(ts) ? ts : 0,
      session_id: init?.session_id,
      model: init?.model,
      prompt,
      num_turns: result?.num_turns,
      duration_ms: result?.duration_ms,
      total_cost_usd: result?.total_cost_usd,
      is_error: result?.is_error,
      stop_reason: result?.stop_reason,
    };
  } catch {
    return null;
  }
}

app.get("/transcripts", requireAuth, async (c) => {
  const limit = Number(c.req.query("limit") ?? 50);
  let days: string[];
  try {
    days = (await readdir(TRANSCRIPTS_DIR)).filter((d) => DAY_DIR_RE.test(d));
  } catch {
    return c.json({ transcripts: [], total: 0 });
  }
  days.sort().reverse();

  const summaries: TranscriptSummary[] = [];
  outer: for (const day of days) {
    let files: string[];
    try {
      files = (await readdir(path.join(TRANSCRIPTS_DIR, day))).filter((f) =>
        TRANSCRIPT_FILE_RE.test(f),
      );
    } catch {
      continue;
    }
    files.sort().reverse();
    for (const file of files) {
      const summary = await summarizeTranscript(day, file);
      if (summary) summaries.push(summary);
      if (summaries.length >= limit) break outer;
    }
  }
  return c.json({ transcripts: summaries, total: summaries.length });
});

app.get("/transcripts/:date/:file", requireAuth, async (c) => {
  const date = c.req.param("date");
  const file = c.req.param("file");
  if (!DAY_DIR_RE.test(date) || !TRANSCRIPT_FILE_RE.test(file)) {
    return c.json({ error: "invalid path" }, 400);
  }
  try {
    const contents = await readFile(
      path.join(TRANSCRIPTS_DIR, date, file),
      "utf-8",
    );
    return c.body(contents, 200, {
      "content-type": "application/x-ndjson",
    });
  } catch {
    return c.json({ error: "not found" }, 404);
  }
});

serve({ fetch: app.fetch, port: PORT }, ({ port }) => {
  console.log(`clis-worker listening on :${port} (data: ${DATA_DIR})`);
});
