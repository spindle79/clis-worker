# syntax=docker/dockerfile:1.7

FROM golang:1.26-bookworm AS go-builder
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
# Pinned to spindle79's fork so worker-relevant doc edits and patches can ship
# from the same org. Sync upstream from mvanhorn/printing-press-library as needed.
RUN git clone --depth=1 https://github.com/spindle79/printing-press-library.git
ENV CGO_ENABLED=0 GOFLAGS="-trimpath"

# Slim each SKILL.md to a recipes-only reference at build time (drops install /
# MCP / "Direct Use" boilerplate the worker image doesn't need). Worker addenda
# are appended afterward in the runtime stage.
COPY scripts/extract-recipes.sh /usr/local/bin/extract-recipes.sh
RUN chmod +x /usr/local/bin/extract-recipes.sh && mkdir -p /out/docs

WORKDIR /build/printing-press-library/library/developer-tools/scrape-creators
RUN go build -ldflags="-s -w" -o /out/scrape-creators-pp-cli ./cmd/scrape-creators-pp-cli \
 && go build -ldflags="-s -w" -o /out/scrape-creators-pp-mcp ./cmd/scrape-creators-pp-mcp \
 && extract-recipes.sh SKILL.md scrape-creators-pp-cli > /out/docs/scrape-creators-pp-cli.md

WORKDIR /build/printing-press-library/library/productivity/slack
RUN go build -ldflags="-s -w" -o /out/slack-pp-cli ./cmd/slack-pp-cli \
 && go build -ldflags="-s -w" -o /out/slack-pp-mcp ./cmd/slack-pp-mcp \
 && extract-recipes.sh SKILL.md slack-pp-cli > /out/docs/slack-pp-cli.md

# contentful-pp-cli ships as a standalone repo (not part of the printing-press-library
# monorepo), so it gets its own clone + build pair.
WORKDIR /build
RUN git clone --depth=1 https://github.com/spindle79/contentful-pp-cli.git
WORKDIR /build/contentful-pp-cli
RUN go build -ldflags="-s -w" -o /out/contentful-pp-cli ./cmd/contentful-pp-cli \
 && go build -ldflags="-s -w" -o /out/contentful-pp-mcp ./cmd/contentful-pp-mcp \
 && extract-recipes.sh SKILL.md contentful-pp-cli > /out/docs/contentful-pp-cli.md

# ga4-pp-cli — Google Analytics Data API v1beta CLI. Same standalone-repo pattern
# as contentful-pp-cli; push the local clis/ga4-pp-cli/ tree to spindle79/ga4-pp-cli
# before this build runs.
WORKDIR /build
RUN git clone --depth=1 https://github.com/spindle79/ga4-pp-cli.git
WORKDIR /build/ga4-pp-cli
RUN go build -ldflags="-s -w" -o /out/ga4-pp-cli ./cmd/ga4-pp-cli \
 && go build -ldflags="-s -w" -o /out/ga4-pp-mcp ./cmd/ga4-pp-mcp \
 && extract-recipes.sh SKILL.md ga4-pp-cli > /out/docs/ga4-pp-cli.md

# screaming-frog-pp-cli — Headless wrapper around Screaming Frog SEO Spider.
# Same standalone-repo pattern as contentful / ga4.
WORKDIR /build
RUN git clone --depth=1 https://github.com/spindle79/screaming-frog-pp-cli.git
WORKDIR /build/screaming-frog-pp-cli
RUN go build -ldflags="-s -w" -o /out/screaming-frog-pp-cli ./cmd/screaming-frog-pp-cli \
 && go build -ldflags="-s -w" -o /out/screaming-frog-pp-mcp ./cmd/screaming-frog-pp-mcp \
 && extract-recipes.sh SKILL.md screaming-frog-pp-cli > /out/docs/screaming-frog-pp-cli.md

FROM node:24-bookworm-slim AS node-builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --include=dev
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini jq python3-minimal \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=go-builder /out/scrape-creators-pp-cli /usr/local/bin/scrape-creators-pp-cli
COPY --from=go-builder /out/scrape-creators-pp-mcp /usr/local/bin/scrape-creators-pp-mcp
COPY --from=go-builder /out/slack-pp-cli /usr/local/bin/slack-pp-cli
COPY --from=go-builder /out/slack-pp-mcp /usr/local/bin/slack-pp-mcp
COPY --from=go-builder /out/contentful-pp-cli /usr/local/bin/contentful-pp-cli
COPY --from=go-builder /out/contentful-pp-mcp /usr/local/bin/contentful-pp-mcp
COPY --from=go-builder /out/ga4-pp-cli /usr/local/bin/ga4-pp-cli
COPY --from=go-builder /out/ga4-pp-mcp /usr/local/bin/ga4-pp-mcp
COPY --from=go-builder /out/screaming-frog-pp-cli /usr/local/bin/screaming-frog-pp-cli
COPY --from=go-builder /out/screaming-frog-pp-mcp /usr/local/bin/screaming-frog-pp-mcp

# Stage the per-CLI recipes-only docs from go-builder, then append any
# worker-local addenda (extra recipes, bug-workarounds) at /app/docs/<cli>.md.
# The router that picks which doc to read lives in the worker's system prompt;
# no /app/docs/README.md is needed at runtime.
COPY --from=go-builder /out/docs /app/docs/
COPY docs/addenda /tmp/docs-addenda
RUN if [ -d /tmp/docs-addenda ]; then \
      for f in /tmp/docs-addenda/*.md; do \
        [ -f "$f" ] || continue; \
        name=$(basename "$f"); \
        if [ -f "/app/docs/$name" ]; then \
          printf '\n\n---\n\n## Worker addendum\n\n_Workarounds and local-only context not yet upstream in this CLI._\n\n' >> "/app/docs/$name"; \
          cat "$f" >> "/app/docs/$name"; \
        fi; \
      done; \
      rm -rf /tmp/docs-addenda; \
    fi

# Don't reuse the host-generated lockfile here — its optional-dep selections are
# platform-specific (the Agent SDK ships native binaries per platform/libc).
# Letting npm re-resolve in the container guarantees the correct linux variant.
COPY package.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --omit=dev --no-package-lock

COPY --from=node-builder /app/dist ./dist

ENV NODE_ENV=production \
    PRESS_DATA_DIR=/data \
    PORT=3000
RUN mkdir -p /data

EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
