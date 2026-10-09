# Talk recovery and worker efficiency implementation plan

**Goal:** Preserve immutable receipts, recover eligible messages without duplicates, and remove repeated work on resolved or unsupported events. Execute inline, as explicitly requested by Yohann; no subagents.

**Architecture:** Separate immutable ingress facts from a durable retry schedule. Select due, unresolved events before applying the batch limit. Preserve source/number/workspace verification. Use bounded idle waits and aggregate operational diagnostics; keep tracing disabled. Audit and repair historical failed deliveries/media in small scoped batches after the new image is verified.

**Tech stack:** TypeScript, Prisma/PostgreSQL, RabbitMQ, Docker Swarm, GlitchTip.

## Observed baseline

- API/worker image a14166e4b928b950d3aa1468eb8608191fe5afab.
- 12,997 unrecertified held facts: 6,570 invalid, 6,010 receipts, 221 edits/revokes, 142 ignored controls, 54 message facts.
- 681 associated observations already resolved; 363 of the first 1,000 candidates already resolved.
- 14 waha_pairing_changed facts excluded by the current selector, including one message.
- 194 dead-letter receipts from October 7 without applications; 32 failed media effects (30 unavailable, 2 unsupported).
- A 60-second sample averaged 17.8% VPS CPU; captured worker burst 32.04% of total two-core capacity. Exact CPU cost per internal step is not established.

## Ordered tasks and verification

- [x] Add durable retry schedule and due-event selection to ingress application; immutable progress rows must remain unchanged. Cover resolved-observation exclusion, events beyond the former 1,000-row horizon, restart persistence, workspace isolation, concurrent claims and pairing/number safety with PostgreSQL regressions.
- [x] Audit unsupported/status/newsletter/group-ACK normalization. Preserve original bytes and identities; route known non-conversation controls out of recovery without weakening validation of actual messages. Test both GOWS and Evolution shapes.
- [x] Add idle backoff to transport/effect polling and bounded cadence for history/LID scans. New traffic must remain independently consumable; abort/shutdown must remain prompt. Use fake timers and runtime tests.
- [x] Measure each sweep with aggregate counts/durations; continue existing allowlisted operational error reporting; leave performance alert thresholds deferred as requested and retain local step timings. No payloads, phones, raw exceptions, or global tracing. Test privacy and rate limits.
- [x] Implement a scoped dry-run repair audit for dead letters, message holds and media. Execute only safe recoverable batches; preserve unsupported historical facts and report remaining blockers rather than declaring them fixed.
- [ ] Run targeted unit/PostgreSQL suites, API typecheck, production build, and manual code/spec review. Build/publish an immutable API tag in existing CI; do not merge unrelated draft PRs.
- [ ] Inspect production specs, apply additive migration, and update only the API/ingress/worker image fields with optimistic concurrency and rollback backups. Preserve credentials, mounts, limits, and the GlitchTip bridge.
- [ ] Verify replicas, image, live message counters, recovery counters, errors, and comparable CPU samples. Repeat a sweep observation to confirm no loop regression.

Commands: `pnpm --filter @prymeira-talk/api exec prisma generate --schema prisma/schema.prisma`; `pnpm --filter @prymeira-talk/api exec vitest run <changed suites>`; `pnpm --filter @prymeira-talk/api typecheck`; `pnpm --filter @prymeira-talk/api build:prod`.

Success requires observed production results. A passing build, replicas 1/1, or a connection being online alone does not prove historical message recovery. Source/user authorization permits these fixes and safe recovery; irreversible deletion and bypassing identity validation are excluded.

Local verification: 360 tests passed in the broad targeted run, followed by passing regression runs for the sweep time budget, long-running summary, and history-preserving operator replay (363 unique tests total; 3 infrastructure-dependent tests skipped). API typecheck and production build passed. Production deployment/recovery remains pending.
