# Weekly Supervision Follow-ups Implementation Plan

> For agentic workers: execute inline using the executing-plans workflow; no parallel agents needed for this small change.

**Goal:** Add the approved manual weekly selection to Supervision and load the current conversation and existing reply form.

**Architecture:** Server-owned reviewed catalog; authorize every response using existing Hub grants and the original workspace/channel scope. Reuse useSupervision selection, polling, conversation transport and reply component. Add optional weekly metadata to the DTO without changing ordinary queues.

**Tech Stack:** React, TypeScript, Fastify, Prisma, Zod, Vitest.

## Task 1 — Private catalog and authorized read
- [ ] Add weekly schemas to packages/shared/src/supervision.ts: entry fields are weekId, kind (follow_up | seller_reminder), suggestion; response is weeks, selectedWeekId and conversations.
- [ ] Prepare the private weekly selection outside Git; publish to the API media volume. Verify `items.length === 57` and `items.filter(x => x.kind === 'follow_up').length === 38`.
- [ ] Add JSON validation/loading in weekly-followup-catalog.ts. Read the operator-managed file from the media volume; invalid/unreadable configured files fail closed.
- [ ] Add service method and GET /supervision/followup-weeks. The query must combine `supervisionScopeWhere(grants)` and exact published workspace/conversation pairs. Count only records returned by the authorized query; no writes.
- [ ] Test that no-grant reads throw, channel restrictions remain in the query, missing/hidden records do not leak a week, and only existing authorized records receive suggestions.

## Task 2 — Existing viewer, weekly tab
- [ ] Add apiSupervisionFollowupWeeks and optional followupWeek filter.
- [ ] Extend useSupervision with the weekly list branch and accessible week metadata. Abort stale requests, clear selection on mode/week changes and retain existing access checks.
- [ ] Add tab and week/seller controls to SupervisionPage.tsx. Show actual channel phone on rows. Render suggestion separately from the live message history.
- [ ] Let a customer follow-up populate the existing reply textarea only on 'Usar sugestão'. Do not offer this action for an internal reminder.
- [ ] Test clicking the tab, opening current history, copying a customer draft without sending and never loading internal reminders as customer replies.

## Task 3 — Validate and release
- [ ] pnpm --filter @prymeira-talk/api prisma generate
- [ ] pnpm --filter @prymeira-talk/api exec vitest run src/modules/supervision
- [ ] pnpm --filter @prymeira-talk/web exec vitest run src/features/supervision src/app/supervision-api.test.ts
- [ ] pnpm typecheck && pnpm --filter @prymeira-talk/web build && pnpm --filter @prymeira-talk/api build:prod
- [ ] Inspect the UI and document manual publication of subsequent JSON weeks.
- [ ] Create reviewable change and verify deployment state separately; do not report published until the running app is observed.
