# Daily campaign counts in Saúde

**Approved scope:** Add only “Disparos hoje” and “Disparos ontem” to each existing number card. Count successful campaign sends, using Brasília calendar days. Keep the existing 24-hour traffic indicators. No export, campaign detail screen, alerts, new journal or changes to sending.

**Approach:** Aggregate existing `campaign_recipients` with `status = 'sent'` and `sent_at` since yesterday's midnight. Join the recipient's workspace/channel to the existing health channels. Count rows rather than attempts and use the existing `saoPauloDayStart` helper. Add one bounded aggregate to the existing admin request; do not scan message bodies or add polling.

## Implementation

- [x] Add a PostgreSQL regression test for successful sends today/yesterday, midnight boundaries, failed/pending/uncertain recipients, retries, separate numbers/workspaces and numbers with no sends. Run before implementation and observe failure on the missing counts.
- [x] Extend `ChannelHealthView` in `apps/api/src/modules/supervision/platform-health.ts` with `campaigns: { today: number; yesterday: number }`. Append the single aggregate to its existing `Promise.all`, then map absent rows to zero. Update its typed test fixture.
- [x] Extend the web response type in `apps/web/src/app/supervision-api.ts` with the additive counts. Render the two labels in `PlatformHealthPage.tsx` with the existing card styles; show an em dash if an older API has no counts. Add only a two-column stats row to `platform-health.css`.
- [x] Verify the actual page rendering for 30/50, zero and missing API fields. Run API health/campaign tests, the PostgreSQL regression, API/web/shared typechecks, and the web production build.
- [ ] Inspect the focused diff, commit, and open a draft PR against the current production release branch. Report implementation and deployment status separately.

## Verification commands

Run with Node 22 and pnpm 10.0.0. Use only the task-owned local PostgreSQL fixture on port 55441, database `supervision_test`, for integration tests.

```sh
pnpm --filter @prymeira-talk/api exec vitest run src/modules/supervision/platform-health.test.ts src/modules/supervision/platform-health.postgres.test.ts src/modules/campaigns/campaign-worker.repository.test.ts
pnpm --filter @prymeira-talk/web exec vitest run src/features/platform-health/PlatformHealthPage.test.ts src/features/platform-health/PlatformHealthPage.campaigns.test.tsx
pnpm -r typecheck
pnpm --filter @prymeira-talk/web build
git diff --check
```
