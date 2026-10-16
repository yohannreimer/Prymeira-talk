# Technical operational alerts: review and deployment gates

This change is prepared for review only. No image has been published, no service/configuration
changed, no production test/callback sent and no live delivery-status call repeated.

## Scope and privacy

Talk branch `codex/operational-alert-diagnostics` starts at `713ca3503bcd979ec35af31b2cbc5b3a5b9fc0ae`
(including the separate WAHA destination fix). Bridge branch
`codex/operational-alert-bridge` starts at `50fcd9e6ab2be4619422e6c2b2b7433b0e8bafd0`.
They are separate checkouts because the bridge has its own deployed image/base.
Apply each patch only to its matching release stream.

The identical `diagnostic-contract.json` files define an explicitly versioned
allowlist. The cross-checkout test compares both copies and runs the real Talk
sanitizer through the native formatter, bridge normalizer, SQLite and a signed
in-memory callback. Runtime dependencies and telemetry destination are unchanged.

Each new diagnostic preserves standard/repository error type, stable error code,
technical cause category and a fixed human-readable technical explanation, capture component/operation/location, up to four relative
frames (filename/line/column), up to three cause types/codes, release, and an
independent random `op_` correlation. `location` is the known capture boundary;
frames locate the original exception. A missing fatal location is `unknown`.
Known Prisma proxy invariants, typed WAHA HTTP failures and destination resolution
remain distinguishable. Unknown messages are not copied: type/frames remain
available and the code/category explicitly state that the cause is unknown.

No message body, customer identifier (including hashed identifiers), SQL, token,
request, provider response, private URL, function name, local absolute prefix,
variable or source/context line is added to the alert. Frames must match a
release-owned source filename or the bundler's fixed entry/chunk grammar.
Monitoring performs a second reconstruction before the SDK transport. The bridge
does a third reconstruction. The local operational warning contains only the same
sanitized diagnostic, so its correlation can be searched without exporting PII.

Runtime `failed` results and scheduler exceptions now report, including early
runtime failures. Caught exceptions retain their sanitized cause before becoming a
result string. Nested runtime/scheduler propagation reports once. Success, handoff
and intentional reset/ownership skips do not generate failure alerts. Monitoring
failure does not change results, claims, retry rules or delivery decisions.

Impact is limited to `operation_failed`, `delivery_unconfirmed` or `unknown`.
These do not assert that every bubble failed or that a provider accepted/delivered
a message. Recovery is `unknown`; this patch adds no speculative recovered event,
automatic replay, retry or resolution based on silence.

## Native GlitchTip hop

GlitchTip 6.1.8's `gather_issue_tags` aggregates values across an issue. Combining
its independently chosen tags can misattribute a release/correlation/frame. For
the dedicated recipient only, the extension now selects the newest issue event
once, projecting only the permitted JSON tag keys and timestamp. It does not fetch
`data`, titles, culprits, arbitrary tags, user/request fields or message history.
The dedicated payload uses a fixed technical title and empty text.

`context_source=latest_issue_event` and `occurred_at` identify this sample honestly:
it is the newest event at native notification formatting time, not necessarily the
first occurrence that triggered the notification. Envelope `timestamp` remains
bridge receipt time. This is event-driven formatting, not periodic API/history
polling. The query uses GlitchTip's existing issue/event index; batches and body
size remain bounded, and large notifications are split into serial native POSTs.

The native new/reopened-issue notification policy is unchanged. Open-issue repeats
remain suppressed upstream; local capture and bridge deduplication retain their
one-minute gates. Correlation and sample time are excluded from bridge incident
deduplication; changed technical cause/frame/impact can form a distinct identity.
The existing maximum of ten captures/minute/process still applies. Abrupt process
death and loss of the shared host remain outside guaranteed delivery.

`Store.status` is now a pure SELECT projection, including effective expiration and
retention. It works with SQLite `query_only=ON`; expiry cleanup remains the
worker's responsibility. `accepted` still means HTTP 2xx, not Xing processing.

## Verification performed locally

154 Talk tests and 56 bridge tests passed, plus API typechecking and production
build. These counts include the cross-checkout contract/pipeline test.

Run in the Talk checkout (set both paths to the isolated bridge and Python venv):

```sh
TALK_ALERT_BRIDGE_SOURCE=/path/to/bridge/infra/glitchtip-xing \
TALK_ALERT_PYTHON=/path/to/venv/bin/python \
pnpm --filter @prymeira-talk/api exec vitest run src/observability \
  src/modules/agents/agent-runtime.test.ts src/modules/agents/agent-reply-scheduler.test.ts \
  src/modules/waha/waha.client.test.ts src/modules/channels/outbound-router.test.ts \
  src/modules/channels/outbound-router.destination.test.ts \
  src/modules/ingress/http-observability.test.ts src/modules/ingress/consumer-observability.test.ts \
  src/modules/ingress/sweep-observer.test.ts
pnpm --filter @prymeira-talk/api typecheck
pnpm --filter @prymeira-talk/api build:prod
```

The pre-existing WAHA redirect test opens two disposable HTTP servers on loopback;
it needs local socket permission. Fatal/rejection probes use disposable child
processes and an in-memory SDK transport. The bridge suite uses temporary SQLite,
fake native event projections and signed fake callbacks:

```sh
/path/to/venv/bin/python -m unittest discover -s infra/glitchtip-xing/tests -v
```

No full PostgreSQL/RabbitMQ suite was run. The Docker daemon was unavailable, so
the pinned GlitchTip image and actual Django JSON projection still need the
isolated image/database integration gate before any production rollout. The
build installer checks all three upstream source hashes before editing any file.

## Proposed deployment, requiring separate approval

1. Review both branch diffs and rerun the tests above on the reviewed SHAs. Build
   the Talk image from its release stream and the bridge image from its own
   stream. Require the pinned 6.1.8 hash checks and disposable image/database
   integration; stop if the native model/formatter compatibility gate fails.
2. Publish immutable commit images only after those gates. Record digests and
   rollback images. Reconcile the existing service specs rather than redeploying
   an old full stack definition. Preserve secrets, DSN, state volume, keys,
   CPU/RAM limits, process count and startup/embedded worker settings.
3. Update the bridge image first. Keep the persistent native Xing subscription
   active: do not unsubscribe, replace OAuth or enter a manual callback URL.
   Refresh the plugin's catalog/schema before enabling enhanced events; retain
   `talk.operational_alert` and exactly the existing `{projectId: 3}` arguments.
4. In the reviewed bridge container, run
   `manage.py shell < /code/xing-alerts-scripts/configure_diagnostic_alert.py`
   for a dry run. It validates the exact owned project/alert/recipient, threshold
   and secret-bound own bridge route without printing that route. An explicitly
   approved apply sets `XING_DIAGNOSTICS_APPLY=yes` and
   `XING_DIAGNOSTICS_AUTHORIZED=yes`. It only appends `diagnostic_version` to
   the existing recipient's `tags_to_add`; no subscription or callback changes.
5. Update API/ingress/worker commit images and their matching `GLITCHTIP_RELEASE`
   values. Preserve all other service fields. Review schema adoption before
   rollout; an old cached strict payload schema may reject new optional fields.
6. Any real synthetic event/callback and verification of a visible Xing notice
   require explicit approval beyond these local tests. Correlate capture,
   selected sample, bridge event and HTTP receipt; do not call receipt a processed
   notice. Do not re-send an uncertain customer message to validate alerts.

Rollback only the reviewed images and the appended opt-in tag, preserving the
subscription identity/state/secrets. Legacy payloads remain accepted; rollback
does not replay events that arrived without an active subscription.

## Native dispatcher correction — 16 October 2026

A production read compared source-event tag projections with accepted callback
payloads. Source tags contained the error type, frame and independent correlation;
the delivered diagnostic had UnknownError, no frame/correlation and no sampled
occurrence metadata. The installed module global was wrapped, but GlitchTip had
already bound GENERAL_WEBHOOK to the original function in ISSUE_NOTIFICATION_HANDLERS.

The build installer now updates that single registry entry after installing the
wrapper. Other recipient handlers remain unchanged, and general webhooks without
the diagnostic opt-in still delegate to the original formatter. The packaging
regression executes the installed module and registered handler. The pinned-image
gate now sends a disposable Notification through Notification.send_notifications,
AlertRecipient.send and the native dispatcher, with a fake final HTTP transport.
It verifies code/type, relative frame, correlation, release and occurrence source.
