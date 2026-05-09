# slack-pp-cli — known workaround for POST endpoints

POST endpoints (`post_message`, `schedule_message`, `update_message`,
`delete_message`, etc.) have a flag-serialization bug: values for
`--channel` / `--text` / `--thread-ts` are NOT serialized into the HTTP
request body, so Slack rejects with `missing required field: channel`.

**Workaround:** use `--stdin` with the JSON body. The required flags
must still be passed (with dummy values) to satisfy CLI validation:

```bash
echo '{"channel":"<id-or-name>","text":"<message>"}' \
  | slack-pp-cli messages post_message --channel x --text x --stdin --agent
```

Replace `<id-or-name>` with a real channel name (e.g. `general`) or ID
(e.g. `C0123`). The bot must be a member of the channel, or the call
returns `not_in_channel`.

GET endpoints in slack-pp-cli (search, list, doctor, sync, etc.) work
normally and do not need this workaround.
