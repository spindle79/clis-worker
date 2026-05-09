import { serve } from "@hono/node-server";
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { streamText } from "hono/streaming";
import { query } from "@anthropic-ai/claude-agent-sdk";

const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.PRESS_DATA_DIR ?? "/data";
const WORKER_API_KEY = process.env.WORKER_API_KEY;
const MODEL = process.env.AGENT_MODEL ?? "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You are an agent with access to printing-press CLIs installed on PATH.

Each CLI has its own reference doc at /data/docs/<name>.md. Before
invoking commands from a CLI you don't already have docs for in this
turn, load the reference:

  cat /data/docs/<name>.md

If you're unsure which CLI fits the task, start with:

  cat /data/docs/README.md

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
