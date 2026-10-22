# Native WhatsApp conversion bridge

Talk captures authenticated native CTWA attribution. The existing Prymeira Tracking service owns the sole Meta dispatch for the bridge. Never configure a second Meta sender for these conversions. The website lead form/webhook and website tracker are not used.

## Configuration and staged rollout

`CTWA_TRACKING_CONFIG` is a JSON object keyed by exact workspace UUID. Each entry contains `endpoint`, `signingKey` (64 lowercase hex), `enabled`, and optional `autoForward` (default false). Only `https://www.prymeiradigital.com.br/api/integrations/talk-ctwa` is accepted. No URL or credential fallback exists. The signing key is the hex HMAC-SHA256 of UTF8(`prymeira-talk-ctwa:v1:` + workspace UUID) under Tracking's existing UTF8 `SYNC_SECRET`; Talk never needs that root secret or the Meta credential.

Persist `CTWA_TRACKING_CONFIG` in the production stack environment in Portainer. `docker-compose.prod.yml` maps it only to the API service; its empty default keeps the bridge off. A temporary service environment override must also be saved in the stack environment so a later stack redeploy preserves the integration. Never store the signing key in the compose file.

Begin with `enabled: true, autoForward: false` for the selected workspace. This permits explicit manual forwarding and keeps the worker from scanning/exporting anything. Leave production `META_WHATSAPP_CONFIG` absent/disabled. A configured Tracking workspace and every persisted `tracking_*` state are refused by the old direct dispatcher.

1. Apply Tracking migration0023, configure its exact `TALK_CTWA_WORKSPACE_ID`, explicit WABA-linked `META_CTWA_DATASET_ID`/`META_CTWA_ACCESS_TOKEN` and verified `META_WHATSAPP_BUSINESS_ACCOUNT_ID` only after separate security approval, and publish the reviewed Tracking revision first.
2. Build/deploy the API through the normal release gate. No new Talk schema migration or ingress/ingress-worker deployment is needed.
3. Inspect one authorized persisted LeadSubmitted conversion without changing it:

   ```sh
   node apps/api/dist/forward-ctwa-tracking.js --workspace <workspace-uuid> --event <conversion-row-uuid>
   ```

   `--event` is the persisted `CtwaConversionEvent.id` UUID, not the `ctwa_...` external event ID. Default dry run returns only safe IDs, local state/attempt and configuration/core readiness. It makes no claim, reads no contact presentation and does no HTTP. Apply also requires a scoped, non-group conversation contact.
4. With authorization for that selected event, run the identical command with `--apply`. Require central accepted state, the D1 once fence, sanitized HTTP receipt, and the authenticated dashboard row. `tracking_accepted` means Meta acknowledged the event; it does not establish Ads Manager attribution.
5. Only after selected-event verification set `autoForward: true` for that exact workspace. The API process polls every15s, selecting only LeadSubmitted. It shuts down the loop with the API.

## State and recovery contract

Only untouched `pending_validation` attempt0 can enter the bridge. `tracking_forwarding` claims use workspace, row ID, state, attempt count and prior attemptedAt; completion also checks the new attempt. No database transaction spans HTTP. Persisted core scope/native attribution/event ID/time remains the same on every export. Scoped contact name/phone may change on replay; Tracking retains its first presentation and excludes contact from its immutable identity hash.

The bridge mirrors `tracking_accepted`, `tracking_rejected`, and `tracking_unknown` as terminal states. A Meta-unknown outcome must never use the direct sender or retry Meta. `tracking_pending` means Tracking has not finished/attempted Meta; central `sending` is also reported pending because no final result is known. Central D1 never reclaims a `sending` row automatically after a crash.

`tracking_retry` means transport/acknowledgment uncertainty between Talk and Tracking. After60s it can export the same core again; D1 returns its stored outcome without a second Meta send. A `tracking_forwarding` claim older than60s can similarly be recertified using state+attempt CAS. `tracking_blocked` denotes an HTTP4xx bridge/auth/identity failure and is not automatically retried. Diagnose configuration/core conflicts and obtain explicit repair authorization; do not reset conversion fields or bypass the once fence.

Responses are bounded to64KiB and10s. Neither response bodies, raw click IDs, customer messages, signing keys nor tokens are logged or included in operator output. QualifiedLead/Purchase are never created or automatically forwarded by this bridge.

## Local verification

Use only disposable owned PostgreSQL with `CTWA_TEST_DATABASE_URL` pointing to loopback, an explicit port, and database `messaging_test` or `talk_ctwa_test`; production URLs are rejected by the test fixture. Install frozen dependencies, generate Prisma, migrate the disposable fixture, then run attribution/WAHA tests, API typecheck and `build:prod`. No live Meta or Tracking requests are needed.
