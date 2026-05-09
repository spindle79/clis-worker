# syntax=docker/dockerfile:1.7

FROM golang:1.26-bookworm AS go-builder
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN git clone --depth=1 https://github.com/mvanhorn/printing-press-library.git
WORKDIR /build/printing-press-library/library/developer-tools/scrape-creators
ENV CGO_ENABLED=0 GOFLAGS="-trimpath"
RUN go build -ldflags="-s -w" -o /out/scrape-creators-pp-cli ./cmd/scrape-creators-pp-cli \
 && go build -ldflags="-s -w" -o /out/scrape-creators-pp-mcp ./cmd/scrape-creators-pp-mcp

FROM node:24-bookworm-slim AS node-builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --include=dev
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=go-builder /out/scrape-creators-pp-cli /usr/local/bin/scrape-creators-pp-cli
COPY --from=go-builder /out/scrape-creators-pp-mcp /usr/local/bin/scrape-creators-pp-mcp

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
