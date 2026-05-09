import { serve } from "@hono/node-server";
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
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
  slack-pp-cli            — 66 Slack endpoints — send messages, search conversations,
                            monitor channels, manage workspace. Auth via SLACK_BOT_TOKEN.
  contentful-pp-cli       — 134 Contentful endpoints across CMA, CDA, CPA, GraphQL, and
                            Images, plus 11 transcendence commands powered by a local
                            SQLite mirror: orphans (find unreferenced entries/types/assets),
                            refs / refs-broken (offline reference graph walker + dangling-link
                            finder), diff (full environment diff incl. releases, scheduled
                            actions, tags, tasks, roles), migrate-gen (emit a runnable
                            contentful-migration JS from an env diff), field-usage (per-locale
                            fill-rate stats), validate-content (run content-type validations
                            offline), entries bulk-publish/bulk-unpublish/bulk-validate
                            (SQL-driven, rate-aware against the 7 req/s CMA ceiling),
                            gql-impact (find frontend code referencing a removed field),
                            images url (build images.ctfassets.net URLs with --srcset).
                            Auth: CONTENTFUL_MANAGEMENT_TOKEN (CMA), CONTENTFUL_DELIVERY_TOKEN
                            (CDA), CONTENTFUL_PREVIEW_TOKEN (CPA); CONTENTFUL_SPACE_ID +
                            CONTENTFUL_ENVIRONMENT_ID set defaults but most commands also
                            take them as positional args.
  ga4-pp-cli              — Google Analytics 4 Data API + Admin API (read).
                            Property discovery (run this first if GA_PROPERTY_ID is unset
                            or you need to choose between properties):
                              accounts summaries --ids-only --agent     (flat property list)
                              accounts list                              (account list only)
                              properties describe <id>                   (single property metadata)
                            The 7 Data API endpoints (runReport, runRealtimeReport,
                            runPivotReport, batchRunReports, batchRunPivotReports,
                            checkCompatibility, getMetadata) live under \`properties\`.
                            Plus URL-centric and compound workflows:
                              pages views|engagement|sources|conversions|analytics <pagePath>
                              reports funnel --steps a,b,c
                              schema fetch / list / search "<query>"   (offline cache)
                              templates save|list|run|compat|delete   (named report bodies)
                              drift pages --window 7d --top 20         (period-over-period)
                              watch realtime --interval 30s --top 10   (streaming JSON)
                            Auth via GOOGLE_APPLICATION_CREDENTIALS (path to service-account
                            JSON). GA_PROPERTY_ID is optional — when unset, every command
                            takes --property <id>. The service account can query any GA4
                            property it has Viewer access on; use 'accounts summaries' to
                            enumerate them. Every report response includes \`_warnings\` for
                            sampling, (other)-bucket overflow, and quota exhaustion.

Tooling guidance:
  - Always pass --agent for non-interactive JSON output.
  - Run '<cli> doctor' first if you suspect auth, scope, or store issues.
  - The local SQLite store is at $PRESS_DATA_DIR. Use 'sync' to populate, 'search'/'sql'
    to query without hitting the API.
  - Prefer compound commands (creator find, trends triangulate, contentful-pp-cli orphans,
    contentful-pp-cli diff, ga4-pp-cli pages analytics, ga4-pp-cli drift pages) over
    chaining raw endpoints.
  - For ga4-pp-cli: run 'ga4-pp-cli schema fetch' once per property before searching, then
    'schema search "<term>"' is offline. Save frequent reports with 'templates save <name>'
    and re-run with 'templates run <name>' instead of re-typing flags.

slack-pp-cli — known issue with POST endpoints (post_message, schedule_message,
update_message, delete_message, etc.):

  The flag values for --channel/--text/--thread-ts are NOT serialized into the
  HTTP request body — Slack rejects with "missing required field: channel".
  Workaround: use --stdin with the JSON body. The required flags must still be
  passed (with dummy values) to satisfy CLI validation:

    echo '{"channel":"<id-or-name>","text":"<message>"}' \\
      | slack-pp-cli messages post_message --channel x --text x --stdin --agent

  Replace <id-or-name> with a real channel name (e.g. general) or ID (e.g. C0123).
  The bot must be a member of the channel, or the call returns "not_in_channel".
  GET endpoints in slack-pp-cli (search, list, doctor, sync, etc.) work normally.

contentful-pp-cli — usage notes:

  - Most CMA / CDA / CPA commands take <space_id> <environment_id> as positional
    args even when env vars are set. Pass them explicitly:
      contentful-pp-cli entries list "$CONTENTFUL_SPACE_ID" master --json --agent
  - Bulk operations default to dry-run preview. Pass --confirm to execute against
    the API; the adaptive limiter starts at 5 rps (override with --rate-limit-rps).
  - Transcendence commands (orphans, refs, refs-broken, diff, field-usage,
    validate-content, gql-impact, images url) require a sync first — run
    'contentful-pp-cli sync --full' to populate the local mirror, then query.
  - 'migrate run' shells out to 'npx contentful-migration' which is NOT installed
    in this image. Use 'migrate-gen' to emit the script; execute it on a host that
    has Node + npx available.

Be concise. Return the answer the caller asked for, not a play-by-play of your tool calls.`;

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
