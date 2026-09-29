# WhatsApp Groups Implementation Plan

> **For agentic workers:** Execute these tasks inline with tests before each behavior change.

**Goal:** Show incoming WhatsApp group chats in Talk and allow human replies without exposing groups as CRM contacts or running automated actions.

**Architecture:** Reuse the existing conversation foreign key with a typed group identity and exact `@g.us` JID. Route group webhooks through a guarded ingestion branch and render sender metadata in the inbox. Keep all automated/direct-recipient paths restricted to person contacts.

**Tech Stack:** Fastify, Prisma/PostgreSQL, Evolution API, React, TypeScript, Vitest.

---

### Task 1: Typed identity and API contracts

**Files:** `apps/api/prisma/schema.prisma`, new Prisma migration, `packages/shared/src/domain.ts`, `apps/api/src/modules/conversations/conversations.service.ts`.

- [ ] Add `Contact.isGroup Boolean @default(false)`, migrate with a default, and regenerate Prisma.
- [ ] Add optional `isGroup` on `ConversationDto` and optional sender label/JID on `MessageDto`.
- [ ] Map group identities to inbox DTOs while hiding their JID from contact phone actions.
- [ ] Add DTO tests for direct and group records.

### Task 2: Group webhook ingestion

**Files:** `apps/api/src/modules/evolution/evolution.routes.ts`, `apps/api/src/modules/evolution/evolution.schemas.ts`, `apps/api/src/modules/evolution/evolution.client.ts`, associated tests.

- [ ] Add a failing webhook test with `@g.us`, participant and push name; ensure it persists a group conversation and message.
- [ ] Resolve and validate the group JID separately from direct phone numbers.
- [ ] Resolve subject via Evolution group info, with fallback when unavailable.
- [ ] Store sender metadata and skip direct-only scheduling and observers.
- [ ] Verify duplicate event handling and direct webhook regressions.

### Task 3: Contact isolation and manual sending

**Files:** `apps/api/src/modules/contacts/contacts.service.ts`, campaign recipient services/routes, `apps/api/src/modules/conversations/conversations.service.ts`, associated tests.

- [ ] Exclude group identities from CRM/contact listings and campaign/broadcast recipient selection.
- [ ] Send manual text/media/audio to the exact group JID and reject contact-card sends to groups.
- [ ] Verify the Evolution provider receives `number: '<id>@g.us'` and a direct recipient still receives its phone.

### Task 4: Inbox presentation

**Files:** `apps/web/src/features/inbox/InboxPage.tsx`, inbox display helpers and tests.

- [ ] Show group name and a group marker in the list/header.
- [ ] Show participant label on each inbound bubble.
- [ ] Hide contact identity/CRM and AI controls in group conversations while keeping composer and status.
- [ ] Verify group and direct views in focused interaction tests.

### Task 5: Release verification

- [ ] Run focused API/web tests, `pnpm typecheck`, and `pnpm build`.
- [ ] Inspect final diff and current remote head to avoid stale release.
- [ ] Deploy the exact tested commit, then check health and a real group webhook if available without sending unsolicited messages.
