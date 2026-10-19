# Release validation and immutable image selection

`publish-images.yml` validates the exact `github.sha` before either image can be published. The stabilization branch `codex/audit-stabilization-20261015` is explicitly included in push validation/publication, so its exact head SHA is gated. Pull requests run the same validation on their event revision without publishing. The gate installs the lockfile, generates Prisma, runs workspace typechecks and unit tests, builds the API executables and web app, applies every migration to disposable databases, and executes each opted-in PostgreSQL/RabbitMQ suite serially. It additionally requires nonempty controlled-load and migration-upgrade qualification reports from the same invocation and source revision. A previous report with the same SHA is insufficient: run ID, source state and start/completion times must match. Missing, skipped, stale or working-tree evidence cannot produce a release manifest. Empty or skipped integration suites fail the gate. Failure stops publication; failed validation reports remain available as workflow artifacts.

The `release-<SHA>` artifact contains `release-manifest.json`: the validated revision, API and web image digests, ingress and worker commands (both use the API image), migration names with SQL hashes, and the configuration checks needed before deployment. It records build evidence, not the observed migration or feature flag state of production.

Images now receive immutable SHA tags only. This workflow no longer moves `latest`; existing deployment definitions that rely on `latest` must be changed to the chosen manifest's SHA or digest during a separately reviewed rollout. Keep the previous manifest for rollback. Redeploy its exact digests only after checking compatibility with the applied additive schema; the workflow never reverses database migrations or deploys a service.

## Local validation

Use only an owned, disposable PostgreSQL cluster and a dedicated RabbitMQ `talk_test` vhost. `TALK_TEST_DATABASE_ADMIN_URL` must target the `postgres` database on loopback. Its user needs permission to create the fixed disposable database names. The preparation step creates missing fixture databases and applies migrations. The dedicated `talk_upgrade_test` schema alone is reset to the immutable 82-migration baseline, after strict loopback/port/database and observed `data_directory` equality checks. It never drops databases or clears another application’s queues. Baseline SQL must match commit `27fa3a06513d459e594f69c883fd777913764c5d`; CI checks that commit out into ignored `.validation/schema-base`. All other fixture databases qualify a clean install of all 83 migrations.

```sh
export TALK_TEST_POSTGRES_PORT=55439
export TALK_TEST_AMQP_PORT=56739
# Exact SHOW data_directory of the owned disposable cluster (mandatory):
export TALK_TEST_POSTGRES_DATA_DIRECTORY='/absolute/path/to/owned/fixture/pgdata'
export TALK_SCHEMA_BASELINE_PRISMA='/absolute/path/to/immutable/27fa3a0/apps/api/prisma/schema.prisma'
export TALK_TEST_DATABASE_ADMIN_URL='postgresql://talk_test:talk_test@127.0.0.1:55439/postgres'
export INGRESS_TEST_AMQP_URL='amqp://talk_test:talk_test@127.0.0.1:56739/talk_test'
node apps/api/scripts/validation/run.mjs
```

The supported phases are `unit`, `build`, `prepare`, and `integration`. With no phase, all phases run in order. Unit tests run with opt-in integration URLs and fixture port overrides removed; integration URLs are constructed and validated separately. Use the full sequence for release evidence. `integration` assumes the compiled API and disposable migrations are ready. A local run with uncommitted files is labelled `working-tree` and cannot produce an eligible release manifest. Generated reports live in ignored `validation-artifacts/`.

Each integration file runs in a separate Vitest process with one worker and file parallelism disabled, because several historical fixtures sweep shared work queues. The harness discovers opt-in tests from their environment variables so new PostgreSQL or RabbitMQ suites join the gate automatically. Run the full shared-fixture harness only when other development agents are not exercising those databases.

Reset expectations preserve canonical message rows with `hiddenByReset=true`, hide visible history and remove disposable followup/session state. A campaign with unconfirmed external delivery rejects reset with `CONVERSATION_RESET_DELIVERY_UNCONFIRMED`; reset cannot authorize an automatic resend.

For a local diagnostic run only, `TALK_VALIDATION_KEEP_GOING=true` with the `integration` phase collects every failing suite while continuing serially. It still exits nonzero and cannot create successful release evidence when any suite fails. CI uses fail-fast behavior.


## Qualification and limits

The compiled production-stage rehearsal uses real HTTP authentication, RabbitMQ and worker application against owned loopback fixtures: 80 canonical identities and 160 dual-provider envelopes paced over 10 seconds, with 2,930 synthetic canonical addresses in the same workspace. The compiled worker runs bounded recovery on three physical connections through a synthetic GOWS HTTP contract on its own normal event loop. Contended turns may make verified progress, or yield safely: claimed work retains checkpoint/metadata/backoff, and a timeout before claim leaves the connection untouched with its original priority. The fixture records both categories and later progress separately. It changes only synthetic next-attempt times before waiting for the compiled worker’s next real cadence; this proves resume, not elapsed backoff scheduling. Runtime recovered totals may omit a partial commit before an error, so the oracle separately records persisted identities. The oracle checks exact identities, durable effects across restart/late duplicate, no autonomous historical effects and per-turn page/work budgets. External polling of finalized applied receipts (25 ms interval) measures client-send-to-durable-visibility latency, including lock waiting; transaction `now()` timestamps alone cannot measure that wait. Gate objectives remain ingress p95 <500 ms and application p95 <2 s, including the observed recovery-overlap subset. CPU is cumulative `ps time` delta over the sampled traffic window; RSS samples and CPU resolution are recorded. This is a controlled synthetic qualification, not a capacity, restore or live WhatsApp certification.

The upgrade suite starts from the immutable 82 SQL migrations, populates canonical IDs, stored media metadata, receipt-backed obligations and an original checkpoint, then deploys migration 83. It checks ledger hashes, FKs and the validated constraint; rejects invalid null coordinates, autonomous no-receipt effects and wrong tenants; tests first-phase lock timeout atomic rollback and DML compatibility with the validation lock. Existing effect handlers/runner must remain byte-identical to the baseline and execute new presentation obligations. The actual old WAHA reader must discard a new v2 cursor and rescan the original checkpoint; canonical idempotence has separate integration coverage.

CI prepares Node 22.23.3, PostgreSQL 16.13 and RabbitMQ 3.12.14 with audited immutable Docker digests, plus the existing pinned GOWS container job. The local run used native PostgreSQL 16.14 and RabbitMQ 4.3.6; Docker was unavailable. Linux CI and real provider container jobs were prepared but were not remotely executed by this task. Local results do not prove behavior of those exact service images or the real Evolution image.

## Monitored rollout and rollback

Use the [messaging reference](../messaging/README.md) for workspace baseline/delta thresholds and stop criteria. Capture legacy-held counts separately; overall health may already be degraded. Persisted recovery lag/failures/leases/backoff do not establish live broker/provider health or complete historical coverage. Do not change remote alert configuration as part of this gate.

Migration 83 commits atomic DROP/ADD NOT VALID in one bounded transaction, then validates in another. If validation or migration ledger completion fails, inspect the actual constraint and Prisma ledger, resolve the observed state and retry. Never mark a migration applied without observing its successful required phases.

Disable gap recovery before selecting any older Evolution engine: the original legacy scan path is unbounded. Rollback must retain the Task 1 send safety fix (`bd6282e` or its reviewed equivalent); blindly restoring the old baseline/51b path restores unsafe HTTP 400 handling. Retain the release manifest’s exact digests after that compatibility review. Do not reverse the effect-origin constraint once compatible new no-receipt presentation rows exist. Do not purge, replay or reset uncertain sends or abandoned older reconciliation. The immutable baseline remains a qualification reference, not an automatically safe rollback image.
