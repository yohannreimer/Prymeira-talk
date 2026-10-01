# Isolated transport milestone 1A

This runnable ingress is **not the production messaging runtime**. It never imports
`createApp`, starts business schedulers, writes a `Message`, or executes inbound
business effects. Its real consumer transaction creates one `IngressApplication`
with `state=pending_application` per receipt and then ACKs that transport delivery.
Milestone 1B must replace that ACK boundary with the complete canonical Message,
observations, hooks, durable effects and checkpoint transaction before activation.
The existing API webhook writers and production configuration are unchanged.

## Run the owned local processes

Build with `pnpm --filter @prymeira-talk/api build:prod`. From `apps/api`, run
`node dist/ingress.js` and `node dist/ingress-worker.js` in separate processes.
Both require:

- `INGRESS_TRANSPORT_STAGE=isolated-1a`
- `DATABASE_URL`: one of the four owned test databases on `127.0.0.1:55439`
- `INGRESS_AMQP_URL`: owned broker on `127.0.0.1:56739/talk_test`
- `INGRESS_NAMESPACE=talk.isolated.<unique-local-namespace>`
- `INGRESS_PRIVATE_ROOT`: canonical absolute path to an owned 0700 directory
- `INGRESS_WORKSPACE_ALLOWLIST`: comma-separated isolated workspace IDs

HTTP also uses `INGRESS_EVOLUTION_SECRET`, `INGRESS_WAHA_SECRET`, and optional
`INGRESS_PORT` (default 4011). It binds only `127.0.0.1`. Optional server-owned
`INGRESS_EVOLUTION_ALIASES` preserves private aliases ending in `/:workspaceId`.
No `.env`, provider webhook configuration or production route is modified.

Routes: `/webhooks/evolution/:workspaceId`, `/webhooks/waha/:workspaceId`
(and optional `/:connectionId`), `/webhooks/meta/:workspaceId`. Meta secrets and
phone-number/connectionMode authority come from the persisted integration config.
WAHA uses single `X-Webhook-Hmac` and `X-Webhook-Hmac-Algorithm: sha512` headers,
matching pinned WAHA sender source `55a7d78e3feaf24280fd2a16177ad6187202ea00`.
`/health` reports publisher readiness and explicitly says application is unconnected.

## Durable boundaries

Authentication checks the original bytes before parsing/storing. The original byte
digest is retained, while known envelope credentials and credential URL parameters
are removed from the private persisted envelope. Raw and normalized artifacts are
owned 0600 files, synced before SQL staging. Binary, QR and encrypted media material
stay in these private files. SQL stores safe references, integrity digests, source
snapshots and exact identity projections; Rabbit contains only version + receipt UUID.
Do not expose this directory through a static HTTP mount. API and worker need the
same persistent private storage. Orphan artifact garbage collection is deliberately
not automatic; a failure before SQL staging may leave an unreferenced private file.

Staging commits before Rabbit I/O. Each HTTP request receives a fresh receipt UUID,
including identical requests without a provider event ID; body/time/hash never
supply message identity. A 202 requires persistent mandatory publication, no return,
a positive publisher confirm and recorded confirmation. An ambiguous outcome returns
503 while preserving the original staged receipt. Retrying transport preserves that
UUID. Publishing is leased and namespace-scoped; recovery cannot take another
namespace's receipts. A flow-control `false` waits on the existing publication and
blocks new work until drain. Block/error/close/deadline retires the session.

Both incoming and retry queues use manual ACK; retries and DLQ copies are explicitly
published with routed confirms before ACKing the original channel delivery. There
is no classic-DLX reliability assumption. Repeated handoff failures reach the durable
DLQ after three failures. Closing a connection requeues its unACKed deliveries;
reconnections never reuse delivery tags. Session teardown waits at most 250 ms for
the close handshake, then destroys only its owned socket and clears its heartbeat.
Consumer shutdown retires the connection before a bounded two-second drain; late
commits retain the same receipt and cannot ACK through a replacement channel.

## Recovery and later application

The worker recovers staged/routed receipts with CAS publication leases. Leases only
coordinate transport and never recertify a provider or lifecycle. Original source
facts, observed ownership and exact native identity remain immutable across QR,
logout, config changes and transport recovery. Old accepted sources are handed off
as pending work; no current permission or operational eligibility is inferred.

After repairing a private artifact/infrastructure issue, the explicit command
`node dist/ingress-recover.js <allowlisted-workspace> <channel-uuid> <receipt-uuid>`
resets only a scoped dead-letter transport budget. The worker republishes the
original receipt. The immutable original, source and pending application UUID stay
unchanged; the retained DLQ item is an audit reference, not another application.
Malformed/unknown transport messages are quarantined privately and their safe
quarantine reference is confirmed to DLQ before ACK.

`journal.frontier` runs a caller-provided authorization check under the canonical
workspace boundary before returning accepted-but-not-applied exact-chat facts.
It includes unscoped events conservatively and fails closed above 1000 entries.
The caller must resolve and authorize every original conversation before supplying
its proven chat aliases. This API is not PN/LID authority resolution, recovered-live
eligibility, checkpoint certification or an AI send gate. Those consumers belong to
later milestones. `pending_application`, including ignored/invalid adapter outputs,
remains recoverable; transport never marks application completion.

## Verification

The PostgreSQL/Rabbit integration suite is opt-in and rejects infrastructure outside
the owned loopback endpoints. Build first, then run:

```
MESSAGING_TEST_DATABASE_URL=<owned-messaging-test-url> \
INGRESS_TEST_AMQP_URL=<owned-test-broker-url> \
pnpm --filter @prymeira-talk/api exec vitest run \
  src/modules/ingress/transport.postgres.test.ts --maxWorkers=1
```

It exercises actual quorum routing/confirms and SQL transactions, fault injection,
namespace/auth isolation, old-source retention, bounded confirmed retry/DLQ,
recovery CLI and separately spawned built ingress/worker processes. Controlled
client injections cover broker block, flow-control and lost callback windows;
these are not claims of broker power-loss, Rabbit 3.12 or production qualification.
