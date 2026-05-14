import { serve } from "@hono/node-server";
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { streamText } from "hono/streaming";
import { query } from "@anthropic-ai/claude-agent-sdk";
import Anthropic from "@anthropic-ai/sdk";
import { runVariations } from "./variations.js";
import { callClaudeCli, ClaudeCliError, whichClaude } from "./claude-cli.js";
import { spawn } from "node:child_process";
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
const ONESHOT_MODEL = process.env.ONESHOT_MODEL ?? "claude-haiku-4-5-20251001";

const anthropic = new Anthropic();

const SYSTEM_PROMPT = `You are an agent with access to printing-press CLIs installed on PATH.

Available CLIs (each has a recipes doc at /app/docs/<name>.md):
  slack-pp-cli            Slack workspace ops — channels, messages, search, users.
  scrape-creators-pp-cli  Social platforms — TikTok, Instagram, YouTube, X, Reddit, Threads, etc.
  contentful-pp-cli       Contentful CMS — entries, content types, environment diff, orphans, references.
  ga4-pp-cli              Google Analytics 4 — page analytics, funnels, drift, real-time.
  screaming-frog-pp-cli   Screaming Frog local-store wrapper. On Render this CLI runs
                          OFFLINE ONLY — the SF binary is not installed in this image, so
                          'crawl' and 'audit broken-links|on-page-seo|structured-data|
                          accessibility|performance' will fail at runtime (run 'doctor'
                          first to confirm). What works against prior crawls in the local
                          SQLite store: 'runs list', 'search', 'sql', 'diff <a> <b>', and
                          the SEO compound commands (orphan-pages, redirect-chains,
                          duplicate-titles, missing-meta, canonical-conflicts, thin-content).
                          To run new crawls, run the CLI locally and rsync the data.db up.

Before running a CLI you don't already have its recipes loaded for in
this turn, run:

  cat /app/docs/<name>.md

Each recipes doc contains scenario-labeled commands; match the request
to a recipe label and run that command. If no recipe fits, run
'<cli> --help' to discover commands directly.

Always pass --agent on commands for compact JSON output. Run '<cli>
doctor' first if you suspect auth, scope, or local-store issues. \`jq\`
and \`python3\` are available for JSON post-processing. The local SQLite
store is at $PRESS_DATA_DIR — use 'sync' to populate it and
'search'/'sql' to query without hitting the live API.

Be concise. Return the answer the caller asked for, not a play-by-play
of your tool calls.`;

export const app = new Hono();

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

async function probeScreamingFrog(): Promise<unknown> {
  return new Promise((resolve) => {
    try {
      const proc = spawn("screaming-frog-pp-cli", ["doctor", "--json"], { timeout: 2000, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.on("error", () => resolve({ binary_resolved: false, error: "doctor binary not found" }));
      proc.on("close", () => {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve({ binary_resolved: false, error: "doctor returned non-json" });
        }
      });
    } catch (e) {
      resolve({ binary_resolved: false, error: String(e) });
    }
  });
}

app.get("/health", async (c) => {
  const claudeBinary = await whichClaude();
  return c.json({
    ok: true,
    model: MODEL,
    dataDir: DATA_DIR,
    hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
    hasClaudeCli: Boolean(claudeBinary),
    claudeCliPath: claudeBinary,
    hasClaudeCodeOAuthToken: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN),
    hasScrapeCreatorsKey: Boolean(process.env.SCRAPE_CREATORS_API_KEY_AUTH),
    hasSlackKey: Boolean(process.env.SLACK_BOT_TOKEN),
    hasContentfulKey: Boolean(process.env.CONTENTFUL_MANAGEMENT_TOKEN),
    hasContentfulSpace: Boolean(process.env.CONTENTFUL_SPACE_ID),
    hasContentfulDeliveryToken: Boolean(process.env.CONTENTFUL_DELIVERY_TOKEN),
    hasContentfulPreviewToken: Boolean(process.env.CONTENTFUL_PREVIEW_TOKEN),
    hasGa4Credentials: Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS),
    hasGa4PropertyId: Boolean(process.env.GA_PROPERTY_ID),
    hasScreamingFrog: await probeScreamingFrog(),
  });
});

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

type OneshotBody = {
  prompt?: string;
  system?: string;
  model?: string;
  maxTokens?: number;
  responseSchema?: {
    name: string;
    description?: string;
    schema: Record<string, unknown>;
  };
};

app.post("/oneshot", requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as OneshotBody;
  if (!body.prompt) return c.json({ error: "prompt required" }, 400);

  const model = body.model ?? ONESHOT_MODEL;
  const maxTokens = body.maxTokens ?? 1024;

  try {
    if (body.responseSchema) {
      const response = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        system: body.system,
        tools: [
          {
            name: body.responseSchema.name,
            description: body.responseSchema.description ?? "Submit the result",
            input_schema: body.responseSchema.schema as Anthropic.Tool.InputSchema,
          },
        ],
        tool_choice: { type: "tool", name: body.responseSchema.name },
        messages: [{ role: "user", content: body.prompt }],
      });

      const toolUse = response.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      if (!toolUse) {
        return c.json(
          { error: "no-tool-use", stopReason: response.stop_reason },
          502,
        );
      }
      return c.json({
        value: toolUse.input,
        model: response.model,
        usage: response.usage,
        stopReason: response.stop_reason,
      });
    }

    const response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system: body.system,
      messages: [{ role: "user", content: body.prompt }],
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return c.json({
      text,
      model: response.model,
      usage: response.usage,
      stopReason: response.stop_reason,
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      return c.json(
        { error: "anthropic-error", status: err.status, message: err.message },
        502,
      );
    }
    return c.json({ error: "internal-error", message: String(err) }, 500);
  }
});

type ClaudeBody = {
  prompt?: string;
  system?: string;
  timeoutSeconds?: number;
};

app.post("/claude", requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as ClaudeBody;
  if (!body.prompt) return c.json({ error: "prompt required" }, 400);

  try {
    const result = await callClaudeCli({
      userMessage: body.prompt,
      systemPrompt: body.system,
      timeoutSeconds: body.timeoutSeconds,
    });
    return c.json({
      text: result.result,
      model: result.model,
      usage: {
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
      },
      stopReason: result.finishReason,
    });
  } catch (err) {
    if (err instanceof ClaudeCliError) {
      const status =
        err.code === "missing-binary"
          ? 503
          : err.code === "timeout"
            ? 504
            : 502;
      return c.json(
        {
          error: err.code,
          message: err.message,
          ...(err.details ?? {}),
        },
        status,
      );
    }
    return c.json({ error: "internal-error", message: String(err) }, 500);
  }
});

type VariationsBody = {
  prompt?: string;
  system?: string;
  model?: string;
  maxTokens?: number;
  count?: number;
  responseSchema?: {
    name?: string;
    description?: string;
    schema?: Record<string, unknown>;
  };
};

app.post("/variations", requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as VariationsBody;
  if (!body.prompt) return c.json({ error: "prompt required" }, 400);
  if (!body.responseSchema?.schema) {
    return c.json({ error: "responseSchema.schema required" }, 400);
  }

  const count = body.count ?? 3;
  if (!Number.isInteger(count) || count < 1 || count > 5) {
    return c.json(
      { error: "invalid-count", message: "count must be an integer in [1, 5]" },
      400,
    );
  }

  const userProps = (body.responseSchema.schema as {
    properties?: Record<string, unknown>;
  }).properties;
  const valueSchema = userProps?.value;
  if (!valueSchema || typeof valueSchema !== "object") {
    return c.json(
      {
        error: "invalid-schema",
        message: "responseSchema.schema.properties.value required",
      },
      400,
    );
  }

  try {
    const result = await runVariations(anthropic, {
      prompt: body.prompt,
      system: body.system,
      model: body.model ?? ONESHOT_MODEL,
      maxTokens: body.maxTokens ?? 1024,
      count,
      valueSchema: valueSchema as Record<string, unknown>,
    });
    if (!result.ok) {
      const status = result.error === "anthropic-error" ? 502 : 500;
      return c.json({ error: result.error, message: result.message }, status);
    }
    return c.json({
      variations: result.variations,
      model: result.model,
      usage: result.usage,
      stopReason: result.stopReason,
    });
  } catch (err) {
    return c.json({ error: "internal-error", message: String(err) }, 500);
  }
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

if (!process.env.CLIS_WORKER_NO_AUTO_SERVE) {
  serve({ fetch: app.fetch, port: PORT }, ({ port }) => {
    console.log(`clis-worker listening on :${port} (data: ${DATA_DIR})`);
  });
}
