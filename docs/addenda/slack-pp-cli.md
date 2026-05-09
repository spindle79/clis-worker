# slack-pp-cli — worker-specific notes

## Recipes

### Channels the bot is a member of

```bash
slack-pp-cli conversations list --agent | jq '.results.channels[] | select(.is_member == true) | {id, name}'
```

Filter on `is_member: true` — the bare `conversations list` returns every
public channel the token can see, not just channels the bot has joined.
Add `--types public_channel,private_channel` to scope to a specific kind.

### Find a user by email or handle

```bash
slack-pp-cli users --agent --select id,name,real_name,profile.email | jq '.results.members[] | select(.profile.email == "alex@example.com")'
```

`users` returns the full directory; project to the four fields you
usually want and filter on `profile.email`. For id-by-handle, swap the
predicate to `.name == "alex"`.

### Post a message to a channel

```bash
echo '{"channel":"general","text":"Deploy at 3pm"}' | slack-pp-cli messages post_message --channel x --text x --stdin --agent
```

Use `--stdin` with a JSON body — the flag-only form has a known bug
where `--channel` / `--text` aren't serialized into the request (see
"Known issues" below). Channel can be a name (`general`) or ID
(`C0123`); the bot must already be a member or the call returns
`not_in_channel`.

### Search messages by keyword

```bash
slack-pp-cli search "deploy failure" --data-source live --agent --select messages.matches.channel.name,messages.matches.user,messages.matches.ts,messages.matches.text
```

Hit the live API (`--data-source live`) for fresh results. Project to
the four message fields that actually matter; raw responses are
per-message and verbose. Drop the `--data-source` flag to use the local
SQLite store after `slack-pp-cli sync`.

### Channel message history

```bash
slack-pp-cli conversations history --channel C0123 --limit 50 --agent --select messages.ts,messages.user,messages.text
```

Pull the last N messages from a channel by ID. Pass `--oldest`/`--latest`
(Unix timestamps) to window. For threads, follow up with
`slack-pp-cli conversations replies --channel <id> --ts <thread_ts>`.

### Find quiet or stale channels

```bash
slack-pp-cli quiet --days 30 --agent --select id,name,last_message_age_days
```

Local-sync-powered cleanup query — flags channels with no activity in
the last N days. Run `slack-pp-cli sync` first if the local store is
empty.

## Known issues

### POST endpoints — flag values not serialized

POST endpoints (`post_message`, `schedule_message`, `update_message`,
`delete_message`, etc.) have a flag-serialization bug: values for
`--channel` / `--text` / `--thread-ts` are NOT serialized into the HTTP
request body, so Slack rejects with `missing required field: channel`.

**Workaround:** use `--stdin` with the JSON body. The required flags
must still be passed (with dummy values) to satisfy CLI validation.
See the "Post a message to a channel" recipe above for the exact form.

GET endpoints in slack-pp-cli (search, list, doctor, sync, etc.) work
normally and do not need this workaround.
