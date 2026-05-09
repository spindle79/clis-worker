# Worker docs

This folder is the source of the recipes-only docs the agent reads at
`/app/docs/<cli>.md` inside the running container. It is **not** copied
into the image as-is — instead:

1. At image build, [`scripts/extract-recipes.sh`](../scripts/extract-recipes.sh)
   reads each CLI's upstream `SKILL.md` (cloned as part of the
   go-builder stage) and emits a recipes-only doc with just the
   `## Recipes` and `## Known issues` sections plus a tiny header.
2. Any matching `addenda/<cli>.md` in this folder is appended after the
   extracted upstream content. Use addenda for worker-local recipes
   (CLIs that don't have an upstream `## Recipes` section yet, like
   `slack`) or for bug workarounds that aren't upstream yet.

The agent's routing index — "which CLI does this request fit?" — lives
in the system prompt at [`src/server.ts`](../src/server.ts). Edit there,
not here, when adding or renaming a CLI in the worker.

## Layout

```
docs/
├── README.md           ← this file (human reference; not in the image)
└── addenda/
    ├── slack.md        ← appended to /app/docs/slack.md at build time
    └── contentful.md   ← appended to /app/docs/contentful.md at build time
```

## Adding a recipe

If the CLI is one of yours (`spindle79/contentful-pp-cli`,
`spindle79/ga4-pp-cli`): edit the `## Recipes` section in **that repo's**
`SKILL.md` directly. The build extractor will pick it up next deploy.

If the CLI is upstream (`slack`, `scrape-creators` from
`spindle79/printing-press-library`): add the recipe to
`docs/addenda/<cli>.md` here. Keep upstream forks aligned with their
source unless the change is a genuine bug fix.

The recipe format is fixed (matches Notion / Movie-Goat / contentful):

```markdown
### <Scenario label, written as the user might phrase it>

\`\`\`bash
<exact command with --agent and any --select / --limit defaults>
\`\`\`

<One sentence of rationale; a second only if the most common variant
needs it.>
```
