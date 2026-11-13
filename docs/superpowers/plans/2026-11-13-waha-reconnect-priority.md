# WAHA reconnect priority implementation plan

> Execute inline in the isolated `codex/waha-reconnect-priority-20261113` worktree. User explicitly authorized implementation, tests and the production correction; no additional approval checkpoint is needed for routine implementation decisions.

**Goal:** Recover a reconnection gap before an unrelated old backlog while preserving transport and contiguous historical coverage.

**Architecture:** Keep the existing lease and global contiguous checkpoint; add versioned recent/backlog lane metadata inside the existing recovery JSON. Retain the legacy path for short queues. Store all source-owned progress before external I/O; verify two exhausted identical passes before advancing either lane.

**Tech stack:** TypeScript, Prisma, PostgreSQL, Vitest, existing bounded GOWS adapter.

## 1. Reproduce priority failure

Files: `apps/api/src/modules/channels/waha-history-recovery.postgres.test.ts`.

- [x] Add owned fixtures with a 20-day checkpoint, a known recent outage and both old/recent provider messages. Assert the first query is the recent gap, the recent message is persisted first and the old checkpoint does not move.
- [x] Add recent recovery after restart with page limit 1; a second generation must resume from the last certified recent point without skipping its unfinished range.
- [x] Add old hold/backoff versus fresh reconnect, independent recent retry, concurrent leases and wrong-owner/generation cases.
- [x] Run `MESSAGING_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/messaging_test pnpm exec vitest run src/modules/channels/waha-history-recovery.postgres.test.ts` and observe new assertions fail before implementation.

## 2. Durable lane state

Create `apps/api/src/modules/channels/waha-recovery-lanes.ts`; modify `waha-history-recovery.ts`.

- [x] Export cursor schema plus a version-2 envelope with `owner`, `generation`, `disconnectAt`, `recentThroughAt`, and recent/background lane cursor, due time and failure counts. Preserve a valid v1 background cursor during upgrade.
- [x] Select recent work first when due. Recent completion updates only recentThroughAt; background completion updates only recoveredThroughAt. Mirror earliest due time for diagnostics while the shared lease remains exclusive.
- [x] Reset page verification on physical generation changes, preserving confirmed coverage only for the same account/session. Reset recent due on a new outage/generation. Fail closed for invalid v2 state.
- [x] Preserve the existing pagination/filter/consistency and canonical persistence logic. Bound recent interval to 15 days plus overlap; background stays five minutes plus overlap.

## 3. Verify safety and operational behavior

- [ ] Run the focused suite green. Add coverage for repeated drops, dense pages, hidden rows, mutation, partial persistence, source fencing, stable duplicate scans and legacy checkpoint migration.
- [ ] Run messaging/channels/ingress/WAHA regression tests against the owned fixture; typecheck and production build. Existing outbound, webhook, effect and unread cases must pass.
- [ ] Commit explicit task files, open a PR based on be844f4, run exact-revision release CI, inspect all serial PostgreSQL/RabbitMQ results and immutable image manifest.
- [ ] Update only the ingress worker after no operator child is active. Observe recent lane progress independent of unchanged old backlog, WAHA WORKING, same lifecycle generation, API ready and real traffic. Do not send customer test messages or restart the WhatsApp session.
- [ ] Save sanitized local diagnostic, factual Second Brain report and editorial receipt; report observed SHAs and actual publication state.
