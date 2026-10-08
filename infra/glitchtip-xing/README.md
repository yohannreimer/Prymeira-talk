# GlitchTip → Dot Xing events (Talk only)

This image extends official GlitchTip **6.1.8** in its existing ASGI process.
The base multiarch digest and exact upstream ASGI/MCP hashes are checked at build.
The entrypoint, embedded worker, Django frontend and ingest code remain upstream.
The extension replaces the broad MCP catalog with one read-only delivery-status
tool. Existing OAuth authority, consent UI, registration, token and revocation
routes remain GlitchTip's. Only `event:read` is supported; legacy broad tokens and
API tokens without resource/expiry cannot subscribe. OAuth issuer/resource are
`https://glitchtip.prymeiradigital.com.br/mcp`.

## Configuration (disabled by default)

Build context: `docker build -t glitchtip-xing:6.1.8 infra/glitchtip-xing`.
Run one ASGI process/replica; keep the existing resource limits. Do not enable
multiple web processes sharing this queue. This extension has a single delivery
worker, with one callback request in flight, and sleeps 30 seconds when idle.
Only the local bounded outbox is checked while idle; no API/history/Mac polling.

Required when activating:

- `GLITCHTIP_ENABLE_MCP=True` (upstream setting), `XING_EVENTS_ENABLED=true`.
- `GLITCHTIP_URL=https://glitchtip.prymeiradigital.com.br`.
- `XING_ORGANIZATION_SLUG`: exact existing Talk organization slug.
- `XING_PROJECT_ID`: exact numeric Talk project ID.
- `XING_PROJECT_NAME=pra-talk`: exact native project display name.
- `XING_WEBHOOK_TOKEN_FILE=/run/secrets/xing_webhook_token`: Docker secret with a
  randomly generated URL-safe token of at least 32 bytes (43+ characters).
  `XING_WEBHOOK_TOKEN` is accepted for disposable tests; prefer the file.
- Persistent writable volume at `/var/lib/xing-alerts`, owned by upstream uid 5000.
  `XING_STATE_PATH` defaults to `/var/lib/xing-alerts/state.sqlite3`.
- Keep the existing Django `SECRET_KEY`; subscription credentials use Fernet with
  a purpose-derived HMAC key. Changing it makes existing subscriptions unreadable;
  create fresh subscriptions after planned key replacement.

Configure a native **general webhook** recipient on the Talk project alert
(quantity 1, timespan 1 minute), with destination
`https://glitchtip.prymeiradigital.com.br/xing-alerts/webhook/<secret>` and
`tags_to_add`: `failure_point`, `failure_code`, `service`, `release`.
Do not place this secret path in request/access logs; reverse proxy and Granian
access logging must redact this route or disable access logs. The bridge itself
logs fixed categories only, never URLs, bodies, credentials or exception text.

## Protocol and safe fields

Authenticated JSON-RPC POST `/mcp` implements MCP 2.0 discovery version
`2026-07-28`, event list/subscribe/unsubscribe and tools list/call. The event name
is `talk.operational_alert`; arguments must be exactly `{"projectId": <Talk ID>}`.
The payload includes only the approved failure point/code, service, hexadecimal
release (or null), configured project ID and an exact own issue URL. The envelope
timestamp is **webhook receipt time**: upstream general webhooks do not include
the underlying error occurrence time. Titles, culprits, messages, server names,
environment, unknown tags and private fields are discarded by reconstruction.
All attachments must identify the exact Talk project; mixed-project batches fail.

Every RPC and delivery checks bearer resource, finite lifetime, `event:read`,
active user and current project access via `get_projects_queryset` restricted by
organization, ID and exact name. Subscriptions default to at most one hour and
never exceed token expiry. `ttlMs: null` is accepted with a finite granted expiry.
Refresh updates the same deterministic owner/name/arguments/callback identity.
Key rotation re-verifies the callback and signs with both keys for 120 seconds.
Successful verification is cached by owner/URL/**secret** for at most 300 seconds,
bounded to 100 entries. Challenge failures return `-32015` with categorized reason.

Callbacks must use HTTPS with no credentials, query, fragment or non-443 port.
Each attempt checks all DNS answers, rejects non-public and mapped/transition IPs,
pins the checked addresses and keeps the hostname for TLS/SNI. No proxy settings,
redirects or connection reuse; total deadline 10 seconds, response limit 64 KiB.
Standard Webhooks signs `id.timestamp.exact_body` with validated `whsec_` keys
decoding to 24–64 bytes. Retries preserve `eventId` with fresh signing timestamps.

## Persistence and limits

SQLite commits before 202 acknowledgment; capacity or disk errors return 503.
Default limits: 1,000 pending callback deliveries, 100 subscription identities,
2,000 sanitized retained events, 1,000 short-lived dedup identities, 32 MiB SQLite
page ceiling, seven-day retention, 64 KiB incoming webhook/RPC body and 100
attachments. One webhook fanout is atomic. Completed history can be removed to
make room; pending work is never removed for capacity. Expired/inactive work is
cancelled. Retry attempts cap at six with 30/60/120/240/480-second backoff;
410 deactivates the subscription and 413 permanently stops that delivery.
Dedup is 60 seconds per safe stable identity; recurring/reopened issues can notify
again afterward. Native GlitchTip suppresses repeated still-open issues and
rearms resolved issues when they reopen; the bridge does not patch ingestion or
native alert behavior. Events without an active subscription are not replayed to
later subscriptions (`cursor: null`); only already-queued delivery retries persist.

`get_alert_delivery_status` returns only the authenticated owner's aggregate
pending/accepted/failed/cancelled counts and active subscription count. HTTP
acceptance is **not** proof of processing or a visible notification in Dot.
Invalid bridge setup fails closed for its state and keeps upstream ingest running.

## Local verification and integration gates

Use an isolated environment; dependencies are already present in the pinned image:

```sh
python3 -m venv /tmp/xing-events-venv
/tmp/xing-events-venv/bin/python -m pip install --index-url https://pypi.org/simple aiohttp==3.13.5 cryptography==46.0.7
/tmp/xing-events-venv/bin/python -m unittest discover -s infra/glitchtip-xing/tests -v
```

Run `/code/xing-alerts-scripts/smoke_image.py` inside the built container using
dummy settings and disposable PostgreSQL. It checks imports, the installed
catalog and exact OAuth configuration. Container lifecycle/login/ingest/OAuth
consent checks remain required before deployment. Tests use temporary SQLite,
stub GlitchTip authority/project permission and fake callbacks; they do not
prove real Dot delivery. Production activation requires review of the concrete
OAuth access change, a real Dot subscription, signed synthetic test, visible
notification and CPU observations. No production activation is performed here.

References: [GlitchTip v6.1.8 source](https://gitlab.com/glitchtip/glitchtip-backend/-/tree/v6.1.8)
and [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events).
