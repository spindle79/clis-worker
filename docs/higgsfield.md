# higgsfield — recipes

Higgsfield AI CLI for image / video generation, Soul character refs,
Marketing Studio workflows, and product photoshoots. Not a
printing-press CLI — flag conventions differ from the other CLIs in
this worker.

## Conventions

- Binary names: `higgsfield`, `higgs`, `hf` are all the same binary.
- Output: pass `--json` for raw JSON. There is **no `--agent` flag**.
- Auth: device-login token in `$XDG_CONFIG_HOME/higgsfield/credentials.json`
  (already mounted; agent does not run `auth login`).
- Quick auth check: `higgsfield auth token` — fails if creds are
  missing or expired.

## Recipes

### Check the active account and credit balance
```
higgsfield account status --json
```

### List recent credit transactions
```
higgsfield account transactions --json --size 50
```

### Browse available models
```
higgsfield model list --json                    # all
higgsfield model list --json --image            # image-only
higgsfield model list --json --video            # video-only
higgsfield model list --json --text             # text-only
higgsfield model get nano_banana_2 --json       # one model's params
```

### Generate an image
```
higgsfield generate cost nano_banana_2 --prompt "studio product photo" --json
higgsfield generate create nano_banana_2 \
  --prompt "cinematic product photo" \
  --image <upload_id> \
  --wait --wait-timeout 20m --wait-interval 5s \
  --json
```

### Generate a video (always wait — videos take minutes)
```
higgsfield generate create <video_model> \
  --prompt "slow push-in shot" \
  --image <upload_id> \
  --wait --wait-timeout 20m --wait-interval 5s \
  --json
```

### Inspect or poll an existing job
```
higgsfield generate get <job_id> --json
higgsfield generate wait <job_id> --json --quiet --timeout 20m --interval 5s
higgsfield generate list --json --video --size 50
```

### Upload an input image / video / audio
```
higgsfield upload create ./input.png --json
higgsfield upload list --json --image --size 50
```

### Custom Soul character references
```
higgsfield upload create ./ref1.png --json   # x5; capture upload_ids
higgsfield soul-id create --name Alice --soul-2 \
  --image <id1> --image <id2> --image <id3> --image <id4> --image <id5> \
  --json
higgsfield soul-id wait <soul_id> --json
higgsfield soul-id list --json
```

### Product photoshoot (mode-specific prompt enhancement)
```
higgsfield product-photoshoot create \
  --mode lifestyle_scene \
  --prompt "fragrance bottle on a marble countertop, soft window light" \
  --image bottle.jpg \
  --count 3 \
  --json
```
Modes: `product_shot`, `lifestyle_scene`, others — confirm with
`higgsfield product-photoshoot create --help`.

### Marketplace cards (e.g. Amazon-style main / secondary / A+ images)
```
higgsfield marketplace-cards create \
  --scope product-images \
  --prompt "peach lemonade can, retail-ready hero" \
  --image can.png \
  --json
```

### Marketing Studio — DTC ads, brand kits, products
```
higgsfield marketing-studio brand-kits fetch --url https://example.com --wait --json
higgsfield marketing-studio products fetch --url https://example.com/product --wait --json
higgsfield marketing-studio dtc-ads generate \
  --prompt "hero shot" \
  --format-id <uuid> \
  --brand-kit-id <uuid> \
  --wait --json
higgsfield marketing-studio ad-formats list --json
higgsfield marketing-studio avatars list --json
```

### Workspaces
```
higgsfield workspace list --json
higgsfield workspace status --json
higgsfield workspace set <workspace_id>
higgsfield workspace unset
```

## Failure modes

- `Error: Not authenticated.` → the Secret File seeding step in the
  container entrypoint did not run, or the secret is missing. Confirm
  `/health` reports `hasHiggsfieldCredentials: true`.
- `Session expired.` → the refresh token was rejected (revoked,
  expired, or the higgsfield-side session was killed). Re-run
  `higgsfield auth login` on the operator's laptop, upload the new
  `credentials.json` to Render's Secret Files, and redeploy. (The
  container will overwrite its on-disk copy from the new secret on
  the next cold boot.)
- `Cannot reach token endpoint.` → outbound network issue to
  `higgsfield.ai`. Render egress is shared; usually transient.
