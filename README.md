# Misskey hooks

Cloudflare Worker: **webhook → Misskey API** — creates **local-only, specified-visibility** notes (DM-style) via `POST /api/notes/create`. Misskey then raises **mention** notifications for each recipient (bell + push), not a separate `notifications/create` call (that endpoint only notifies the **token’s own** account). No WebSockets or Durable Objects.

The default Misskey instance URL is **[coretalk.space](https://coretalk.space)** (`MISSKEY_ORIGIN` in `wrangler.jsonc`). The Worker is served at **`hooks.coretalk.space`** when configured.

## Webhook

- **Method:** `POST`
- **Auth:** source IP must appear in `ALLOWED_IPS` (secret, JSON string or array of IPs).
- **Recipients:**
  - Path: `POST /{username}` for a single user, or
  - JSON body: `"users": ["a","b"]` or `"to": ["a","b"]` (string or comma/whitespace-separated string also accepted). Body overrides path when non-empty.
- **Payload:** same event shapes as before (`type`: `notify` | `toast` | `dialog` | `confirm`, plus fields like `body`, `title`, `url`, …).

Text sent to Misskey:

| `type` | Message text |
| --- | --- |
| `toast` | `body` or `text` |
| `notify` | `{header}\n{body}` |
| `dialog` | `{title}\n{body}` |
| `confirm` | `{title}\n{body}\n{url}?ok=1` or `&ok=1` |

Each note is prefixed with an MFM mention line (`@user1 @user2`) so the delivery matches normal mention behavior.

### Notifications (bell)

Recipients get the standard **mention** notification for that note. If someone does not see it, check Misskey **notification settings** for **mentions** (e.g. “only from people I follow”) and either **follow the bot account** used for `MISSKEY_TOKEN` or widen mention notifications for that bot.

## Configuration

| Variable | Where |
| --- | --- |
| `MISSKEY_ORIGIN` | `wrangler.jsonc` → `vars` (e.g. `https://coretalk.space`) |
| `MISSKEY_TOKEN` | `wrangler secret put MISSKEY_TOKEN` — API token with permission to call `notes/create` and `users/show` |
| `ALLOWED_IPS` | Secret — JSON allowlist for webhook callers |

Local dev: `.dev.vars` with `MISSKEY_TOKEN=`, `ALLOWED_IPS=`, optional `MISSKEY_ORIGIN`.

## Cloudflare Workers Builds

Use **`npx wrangler deploy`** for deploys (Workers Builds should use the same command unless you rely on gradual rollouts).

## Related

The [plugin-notifications](https://github.com/coretalkspace/plugin-notifications) AiScript client targeted the old WebSocket API; it is **not** used for this Misskey-DM delivery path.

## License

[CORE License](LICENSE).
