# Release validation and immutable image selection

`publish-images.yml` validates the exact `github.sha` before either image can be published. The stabilization branch `codex/audit-stabilization-20261015` is explicitly included in push validation/publication, so its exact head SHA is gated. Pull requests run the same validation on their event revision without publishing. The gate installs the lockfile, generates Prisma, runs workspace typechecks and unit tests, builds the API executables and web app, applies every migration to disposable databases, and executes each opted-in PostgreSQL/RabbitMQ suite serially. Empty or skipped integration suites fail the gate. Failure stops publication; failed validation reports remain available as workflow artifacts.

The `release-<SHA>` artifact contains `release-manifest.json`: the validated revision, API and web image digests, ingress and worker commands (both use the API image), migration names with SQL hashes, and the configuration checks needed before deployment. It records build evidence, not the observed migration or feature flag state of production.

Images now receive immutable SHA tags only. This workflow no longer moves `latest`; existing deployment definitions that rely on `latest` must be changed to the chosen manifest's SHA or digest during a separately reviewed rollout. Keep the previous manifest for rollback. Redeploy its exact digests only after checking compatibility with the applied additive schema; the workflow never reverses database migrations or deploys a service.

## Local validation

Use only an owned, disposable PostgreSQL cluster and a dedicated RabbitMQ `talk_test` vhost. `TALK_TEST_DATABASE_ADMIN_URL` must target the `postgres` database on loopback. Its user needs permission to create the fixed disposable database names. The preparation step creates missing fixture databases and applies migrations; it does not drop databases or clear other applications' queues.

```sh
export TALK_TEST_POSTGRES_PORT=55439
export TALK_TEST_AMQP_PORT=56739
export TALK_TEST_DATABASE_ADMIN_URL='postgresql://talk_test:talk_test@127.0.0.1:55439/postgres'
export INGRESS_TEST_AMQP_URL='amqp://talk_test:talk_test@127.0.0.1:56739/talk_test'
node apps/api/scripts/validation/run.mjs
```

The supported phases are `unit`, `build`, `prepare`, and `integration`. With no phase, all phases run in order. Unit tests run with opt-in integration URLs and fixture port overrides removed; integration URLs are constructed and validated separately. Use the full sequence for release evidence. `integration` assumes the compiled API and disposable migrations are ready. A local run with uncommitted files is labelled `working-tree` and cannot produce an eligible release manifest. Generated reports live in ignored `validation-artifacts/`.

Each integration file runs in a separate Vitest process with one worker and file parallelism disabled, because several historical fixtures sweep shared work queues. The harness discovers opt-in tests from their environment variables so new PostgreSQL or RabbitMQ suites join the gate automatically. Run the full shared-fixture harness only when other development agents are not exercising those databases.

Reset expectations preserve canonical message rows with `hiddenByReset=true`, hide visible history and remove disposable followup/session state. A campaign with unconfirmed external delivery rejects reset with `CONVERSATION_RESET_DELIVERY_UNCONFIRMED`; reset cannot authorize an automatic resend.

For a local diagnostic run only, `TALK_VALIDATION_KEEP_GOING=true` with the `integration` phase collects every failing suite while continuing serially. It still exits nonzero and cannot create successful release evidence when any suite fails. CI uses fail-fast behavior.
