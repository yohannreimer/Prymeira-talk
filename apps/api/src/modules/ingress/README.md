# Isolated ingress milestones 1A and 1B

This runnable ingress remains isolated from production. It never imports
`createApp` or starts business schedulers. `isolated-1a` preserves the reviewed
transport-only sink and ACKs after a durable `pending_application` handoff.
`isolated-1b` connects the executable worker to `IngressApplicationService`:
digest-verified private receipts, one READ COMMITTED event transaction, canonical
Message/observations, concrete transactional hooks, and unique frozen pending
obligations. ACK follows complete batch conservation and final application commit.
The existing API webhook writers and production configuration remain unchanged.

Stage 1B effects are **pending**, with no handler or timer execution. Stage 1C
must add its own migration for leases/completion while preserving captured cause
and frozen flags; migration 55 deliberately prevents rewriting those facts or
claiming an unimplemented handler completed. Stage 1D owns recertification,
checkpoints, authority resolution and recovery of held facts. No partial production
activation is authorized by either isolated mode.

## Run the owned local processes

Build with `pnpm --filter @prymeira-talk/api build:prod`. From `apps/api`, run
`node dist/ingress.js` and `node dist/ingress-worker.js` in separate processes.
Both require:

- `INGRESS_TRANSPORT_STAGE=isolated-1a` for transport-only, or `isolated-1b` for canonical application (migration 55 required)
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
  src/modules/ingress/transport.postgres.test.ts \
  src/modules/ingress/setup.rabbit.test.ts --maxWorkers=1
```

It exercises actual quorum routing/confirms and SQL transactions, fault injection,
namespace/auth isolation, old-source retention, bounded confirmed retry/DLQ,
recovery CLI and separately spawned built ingress/worker processes. Controlled
client injections cover broker block, flow-control and lost callback windows;
these are not claims of broker power-loss, Rabbit 3.12 or production qualification.

AMQP construction has one 2-second wall-clock budget covering TCP/handshake,
channel creation, topology and consumer registration. Runtime shutdown cancels
construction through the owned socket AbortSignal; every setup continuation checks
cancellation before starting another RPC. Failed or cancelled setup cannot install
a late session. The runtime retries failed setup after its existing 500ms interval.
The setup suite withholds actual Rabbit responses through a disposable TCP proxy
and checks connection release, reconnect and compiled worker SIGTERM.


## Stage 1B application boundary

Receipt UUID is the sole authority input; embedded adapter context never selects
a tenant, session or lifecycle. Before domain access, each event locks workspace,
channel and physical source/config. WAHA messages/actions also require persisted
positive same-number pairing (both verified owners and successful pairing proof),
independent of health/eligible. The immutable accepted pairing snapshot must still
match. All declared native/structured and envelope identities must agree, including
participant/author fields. PN/LID equivalence needs explicit proof with one PN
per family. Application also checks the conserved digest-verified raw bytes, so
receipts staged by an older adapter cannot bypass contradiction checks. Invalid
contradictions stay held with their original source/blobs and no domain effects.
Current QR/status observations are separate and never certify eligibility.
QR bytes remain in private receipt blobs; outbox/Rabbit carry only safe references.

`IngressEventProgress` is uniquely keyed by receipt/event index. A committed Meta
batch position is skipped on retry. `IngressApplication.state=applied` is written
only after every position has a canonical result or explicit conserved decision.
Unsupported Meta media/status identities, incomplete action keys and conflicts are
held, not understood content. An old lifecycle/pairing is
`pending_recertification`; no operator pause or autonomous effects run for it.
The delivery's existing `pending_application` vocabulary is retained; read final
application/progress to distinguish applied from conserved held. `consumedAt`
records the first transport sink commit; application/progress record canonical
completion, and stage 1B ACK is permitted only after that commit.

Created live Message hooks reuse real contact/routing/pause/assistant helpers.
Unread/unhide and domain obligations occur once per Message UUID. Campaign hiding
requires a bound native campaign intent; body/time/provider-global heuristics are
absent. Talk echoes preserve UUID/FKs and do not pause the agent. History/append
and recovered-live without a persisted checkpoint do not trigger attendance.
Groups with absent/fallback names persist one pending `contact.group_metadata`
obligation per contact/channel with original contact/chat/source facts. Stage 1C
will perform the bounded current-source lookup outside the transaction; participant
names never rename the group. Group/history media acquisition remains a presentation obligation without
attendance or autonomous effects. Preview and visibility clocks stay monotonic. Edits, revocations and receipts use
the approved reducers and persist only relevant invalidation/content obligations.

The obligation kinds cover assistant control/message, prospecting eligibility,
handoff brief, realtime invalidation, backfill, triage, follow-up activity, media,
frozen automation occurrence, agent debounce and human-reply improvement. Frozen
flags include source/frontier, origin, logical UUID, control/prospecting context,
content readiness and dependencies. Direct Meta text support is preserved;
scoped WAMID receipts require demonstrated recipient/chat. Existing unsupported
Meta media is explicitly held, without inventing bridge or media parity.

Build first and run `application.postgres.test.ts` alongside the two transport
suites above with `--maxWorkers=1`. The application suite uses synthetic owned
fixtures, real PostgreSQL/Rabbit, the built worker and a crash-after-commit child.
All fixture queues, exchanges, children, private blobs and scoped rows are cleaned.
