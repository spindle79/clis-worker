#!/bin/sh
# Container entrypoint. Bootstraps any per-CLI state that has to land on the
# writable persistent disk before the server starts, then execs the server.
set -e

# higgsfield credentials. The CLI stores tokens at
# $XDG_CONFIG_HOME/higgsfield/credentials.json and rotates the file on every
# token refresh, so it can't live on the read-only Render Secret File mount.
# Seed once from /etc/secrets/higgsfield-credentials.json into /data, where the
# Render persistent disk lets the CLI rewrite it.
HF_CONFIG_DIR="${XDG_CONFIG_HOME:-/data/higgsfield-config}/higgsfield"
HF_CREDS="$HF_CONFIG_DIR/credentials.json"
HF_SECRET=/etc/secrets/higgsfield-credentials.json
if [ ! -f "$HF_CREDS" ] && [ -f "$HF_SECRET" ]; then
  mkdir -p "$HF_CONFIG_DIR"
  cp "$HF_SECRET" "$HF_CREDS"
  chmod 600 "$HF_CREDS"
fi

exec node dist/server.js
