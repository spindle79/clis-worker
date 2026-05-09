# Available CLIs

Each CLI on `PATH` has a reference doc in this directory. **Before invoking
commands from a CLI you don't already have docs loaded for in this turn,
run `cat /data/docs/<name>.md`** to load its reference into context.

Always pass `--agent` to commands for compact JSON output suited for tool
consumption (it expands to `--json --compact --unwrap --no-input --no-color
--yes` and strips Contentful's response envelope where applicable).

| CLI | Reference doc | Use when the task involves |
|-----|---------------|----------------------------|
| `slack-pp-cli` | `slack.md` | Slack workspace ops — list channels, post messages, search conversations, manage workspace. |
| `scrape-creators-pp-cli` | `scrape-creators.md` | Social-platform research (TikTok, Instagram, YouTube, X, LinkedIn, Reddit, Threads, Bluesky, Pinterest), creators, trends, transcripts, ads. |
| `contentful-pp-cli` | `contentful.md` | Contentful CMS — entries/assets/content-types, environment diff, orphans, references, migration generation, image URLs. |
| `ga4-pp-cli` | `ga4.md` | Google Analytics 4 reports — page analytics, funnels, drift, real-time, schema search. |

If the task could fit several CLIs, pick the one whose name matches the
system mentioned in the request. If still unsure, the title and `## When
to use` section at the top of each reference doc clarifies the fit.

Some reference docs include a "Worker addendum" section at the bottom —
local-only workarounds and gotchas not yet in the upstream CLI repo.
Read those if present.
