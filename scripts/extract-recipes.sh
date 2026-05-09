#!/bin/sh
# extract-recipes.sh — extract a recipes-only reference doc from a printing-press
# SKILL.md. Usage:
#
#   extract-recipes.sh <input.md> <cli-name> > <output.md>
#
# Strips the install / auth / MCP / "Direct Use" boilerplate that the worker
# image doesn't need (binaries are pre-installed, env vars are set, no MCP) and
# keeps only the parts the agent actually consults: the `## Recipes` and
# `## Known issues` H2 sections, with a tiny header.
#
# If <input.md> is missing or has neither section, the output is still a valid
# header so the worker's addendum (appended after this) lands cleanly.
set -eu

input="$1"
name="$2"

printf '# %s — recipes\n\n' "$name"
printf 'Recipe-shaped reference for the agent. Match the request to a recipe\nlabel below and run the associated command. Always pass `--agent` for\ncompact JSON output. If no recipe fits, run `%s --help` to discover\ncommands directly. `jq` and `python3` are available for post-processing.\n\n' "$name"

if [ ! -f "$input" ]; then
  printf '_No upstream SKILL.md found for this CLI._\n'
  exit 0
fi

awk '
  BEGIN { capturing = 0; emitted = 0 }
  /^## (Recipes|Known issues)/ {
    capturing = 1
    emitted = 1
    print
    next
  }
  /^## / && capturing { capturing = 0 }
  capturing { print }
  END {
    if (!emitted) {
      print "_No upstream Recipes section in this CLI; see Worker addendum below._"
    }
  }
' "$input"
