# Conversation Reset Implementation Plan

> **For agentic workers:** Use subagent-driven-development for focused implementation and separate specification/code reviews. The user has explicitly authorized the correction, testing and publication in this chat.

**Goal:** Reiniciar conversa clears the visible history, memory and campaign binding while preserving immutable transport facts and stable identities.

**Architecture:** Add a persistent reset visibility marker to Message and a reset boundary to Conversation. Reset is one scoped canonical transaction; history readers, asynchronous workers and the central browser cache honor its boundary.

**Tech Stack:** TypeScript, Prisma/PostgreSQL 16, Fastify, React, Vitest, pnpm, GitHub Actions/GHCR and existing Portainer production services.

## Task 1 — Database and reset transaction

Files: `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20261014223000_conversation_reset/migration.sql`, `apps/api/src/modules/conversations/conversations.service.ts`, `conversations.routes.ts`, `internal-message.ts`, `conversations.service.test.ts` and new `conversation-reset.postgres.test.ts`.

- [x] Add failing regression using actual ingress progress/effects and outbound bindings, no disabled constraints.
- [x] Add `historyResetAt DateTime? @map("history_reset_at")` to Conversation and `hiddenByReset Boolean @default(false) @map("hidden_by_reset")` to Message. Migration adds both columns and a sticky message trigger hiding pre-boundary late imports.
- [x] Replace message deletion with scoped hiding. Resolve retired history inside the transaction; clear operational state and notes, cancel meeting reminders, reset preview clocks/triage and release confirmed campaign reservations with audit. Keep messages and immutable ingress/outbound facts. Return a defined 409 for unsettled campaign sends.
- [x] Scope history and SQL last-message reads with `hidden_by_reset = false`; map reset boundary and explicit null lastMessage.
- [x] Verify reset, repeat reset, isolation, preservation of UUID and facts, late history, new message and rollback in real PostgreSQL.

## Task 2 — Browser reset boundary

Files: `packages/shared/src/domain.ts`, `apps/web/src/app/session/talk-session.ts`, `talk-session.test.ts`, `talk-session.alerts.test.ts`, `apps/web/src/features/inbox/InboxPage.tsx`, related targeted tests, and API DTO mapping.

- [x] Extend DTOs with optional reset boundary/hidden marker while accepting old payloads.
- [x] Write regressions for second-session reset, old events, old HTTP response/replay, fresh events, monotonic repeated resets, and selection changing during POST.
- [x] Enforce the boundary in the central session before alert generation and cache/event updates, clear every cache of the affected conversation and explicit last-message metadata.
- [x] Change the confirmation to describe clearing the atendimento/memory and preserving technical records; clear `targetConversationId` rather than whichever conversation is selected when the POST returns.
- [x] Run shared and web targeted suites/typecheck/build.

## Task 3 — Runtime reset fencing

Files: source-anchor/runtime/automation/assistant/followup/triage/supervision/media/history/ingress/preview modules identified in the source audit and their targeted regressions.

- [x] Source reads and first-message counts exclude hidden history. Completed transport evidence still resolves for dedup/status and never reactivates work.
- [x] Reject hidden source effects centrally; revalidate captured reset boundary before asynchronous agent/automation actions and delivery. Existing claim fencing remains unchanged.
- [x] Prevent old history/audio/previews from re-adding inbox activity, unread/context or notifications. `evaluateFreshConversation` treats a reset conversation as fresh without checking old provider history.
- [x] Test reset during generation and late effect handling plus normal post-reset flow.

## Task 4 — Review and publication

- [x] Run specification review and code-quality review, resolve actionable issues.
- [ ] Run `pnpm -r typecheck`, shared/web/API suites and API production build; run PostgreSQL targeted regressions against an isolated local database.
- [ ] Commit task-owned files and push `codex/fix-conversation-reset`; create a reviewable PR against the deployed production branch and attach it to this chat.
- [ ] Dispatch the existing `publish-images.yml` workflow for this branch; verify both jobs and immutable image tags.
- [ ] Capture current production API/web digests and configured services, including the ingress worker. Run the tested additive Prisma migration with exactly the new migration file before updating images, preserving existing environment/network settings.
- [ ] Update only Talk API/web and the Talk ingress worker to the verified commit images; verify running replicas, health/ready and the reset response/UI in the user's own empty test conversation. Do not send a WhatsApp message or reprocess the webhook as part of final validation.
- [ ] Save a factual brain report, enqueue within the authorized closure flow and report the observed loaded SHA/publication state.
