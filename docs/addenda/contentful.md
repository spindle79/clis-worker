# contentful-pp-cli — worker-specific notes

## Output shape under `--agent` (jq pitfalls)

With `--agent` the response is **already a flat array** (the wrapper
envelope is stripped). When piping to `jq`, **do not** use
`.results.items` or `.items` — those return `null`. Iterate the array
directly:

```bash
contentful-pp-cli entries list "$CONTENTFUL_SPACE_ID" master --agent | jq '.[].sys.id'   # correct
contentful-pp-cli entries list "$CONTENTFUL_SPACE_ID" master --agent | jq '.results.items'  # WRONG → null
```

## `migrate run` requires npx, which is not installed

This image does not have Node/npx available, so `contentful-pp-cli
migrate run` will fail. Use `migrate-gen` to **emit** the migration
script here, then run the generated script on a host that has Node +
npx available. All other commands (sync, diff, orphans, refs,
field-usage, etc.) work as documented.
