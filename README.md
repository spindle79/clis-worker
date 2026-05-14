# clis-worker

Hono server that exposes printing-press CLIs as a Claude Agent SDK `/agent` endpoint.

## Builds

This worker builds against sibling repos in `../` via Docker buildx **named contexts**, which keeps each pp-cli repo self-contained.

### Slim image (default)

Includes binaries on PATH but does NOT install Screaming Frog SEO Spider. Use this when SF is installed on the host or not needed.

    docker buildx build \
      --build-context sf-src=../screaming-frog-pp-cli \
      -t clis-worker:slim \
      --load .

### Heavy image (with Screaming Frog)

Adds Java + Screaming Frog `.deb` (~700MB extra). The license file and EULA acceptance are materialised at container start via env vars; nothing sensitive is baked into the image.

    docker buildx build \
      --build-context sf-src=../screaming-frog-pp-cli \
      -t clis-worker:slim \
      --load .
    docker buildx build \
      -f Dockerfile.with-screaming-frog \
      -t clis-worker:with-sf \
      --load .

Run with:

    docker run -p 3000:3000 \
      -e SCREAMING_FROG_EULA=accepted \
      -e SCREAMING_FROG_LICENCE_USER=... \
      -e SCREAMING_FROG_LICENCE_KEY=... \
      -e WORKER_API_KEY=... \
      -e ANTHROPIC_API_KEY=... \
      clis-worker:with-sf

The `SCREAMING_FROG_VERSION` build arg overrides the pinned SF `.deb` version (default `23.3.0`):

    docker buildx build -f Dockerfile.with-screaming-frog \
      --build-arg SCREAMING_FROG_VERSION=24.0.0 \
      -t clis-worker:with-sf .

## Endpoints

- `GET /` — readiness ping (text)
- `GET /health` — JSON readiness with `hasScreamingFrog: { binary_resolved, ... }` and `hasHiggsfieldCredentials`
- `POST /agent` — streaming agent endpoint (requires `Authorization: Bearer $WORKER_API_KEY` if set)
- `POST /generate/image` — body `{prompt, model?, image?}`. Runs the user prompt through Claude with the higgsfield-generate SKILL.md as system prompt to pick a model and enhance the prompt, then submits a higgsfield job (no `--wait`). Returns `{job_id, status, model, enhanced_prompt, extra_args, poll_url}` immediately.
- `POST /generate/video` — same shape, video models only.
- `GET /generate/:job_id` — poll status; returns `{job_id, status, urls, raw}`. Client should poll every ~5s until `status` is terminal (`completed` / `failed`).
