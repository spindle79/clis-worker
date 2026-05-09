import { serve } from "@hono/node-server";
import { Hono, type MiddlewareHandler } from "hono";
import { streamText } from "hono/streaming";
import { query } from "@anthropic-ai/claude-agent-sdk";

const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.PRESS_DATA_DIR ?? "/data";
const WORKER_API_KEY = process.env.WORKER_API_KEY;
const MODEL = process.env.AGENT_MODEL ?? "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You are an agent with access to printing-press CLI tools installed on PATH.

Available CLIs:
  scrape-creators-pp-cli  — 114 endpoints across 14+ social platforms (TikTok, Instagram,
                            YouTube, X, LinkedIn, Reddit, Threads, Bluesky, Pinterest, etc.)
                            plus compound commands: creator find, trends triangulate,
                            transcripts search, content spikes, ads monitor, bio resolve.

Tooling guidance:
  - Always pass --agent for non-interactive JSON output.
  - Use 'scrape-creators-pp-cli doctor' first if you suspect auth or store issues.
  - The local SQLite store is at $PRESS_DATA_DIR. Use 'sync' to populate, 'search'/'sql'
    to query without hitting the API.
  - Prefer compound commands (creator find, trends triangulate) over chaining raw endpoints.

Be concise. Return the answer the caller asked for, not a play-by-play of your tool calls.`;

const app = new Hono();

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
  }),
);

app.post("/agent", requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { prompt?: string };
  const prompt = body.prompt;
  if (!prompt) return c.json({ error: "prompt required" }, 400);

  return streamText(c, async (stream) => {
    const events = query({
      prompt,
      options: {
        cwd: DATA_DIR,
        allowedTools: ["Bash"],
        systemPrompt: SYSTEM_PROMPT,
        model: MODEL,
      },
    });

    for await (const event of events) {
      await stream.writeln(JSON.stringify(event));
    }
  });
});

serve({ fetch: app.fetch, port: PORT }, ({ port }) => {
  console.log(`clis-worker listening on :${port} (data: ${DATA_DIR})`);
});
