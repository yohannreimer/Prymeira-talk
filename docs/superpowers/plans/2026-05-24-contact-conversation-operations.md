# Contact Conversation Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make contact identity and atendimento operations reliable enough for live testing.

**Architecture:** Add small backend helpers/endpoints for phone canonicalization, conversation read/start, and tag actions. Keep UI changes scoped to ContactsPage, InboxPage, and the API client.

**Tech Stack:** Fastify, Prisma, React, Vite, Vitest.

---

### Task 1: Phone Normalization

**Files:**
- Create: `apps/api/src/modules/contacts/phone-normalization.ts`
- Modify: `apps/api/src/modules/contacts/contacts.service.ts`
- Modify: `apps/api/src/modules/contacts/contacts.service.test.ts`
- Modify: `apps/api/src/modules/evolution/evolution.routes.ts`
- Modify: `apps/api/src/modules/evolution/evolution.routes.test.ts`

- [ ] Add `normalizePhoneForStorage`, `canonicalizePhone`, and `buildPhoneLookupCandidates`.
- [ ] Use canonical lookup during manual create/update and Evolution webhook contact resolution.
- [ ] Add tests for `554799136920` and `5547999136920` resolving to one contact.

### Task 2: Complete Conversation DTOs And Read State

**Files:**
- Modify: `apps/api/src/modules/conversations/conversations.service.ts`
- Modify: `apps/api/src/modules/conversations/conversations.routes.ts`
- Modify: `apps/api/src/modules/conversations/conversations.service.test.ts`
- Modify: `apps/web/src/app/api.ts`
- Modify: `apps/web/src/features/inbox/InboxPage.tsx`

- [ ] Add a shared include/select path for mapping complete conversations.
- [ ] Ensure outbound message updates return contact/channel data.
- [ ] Add `markConversationRead` service and `POST /conversations/:conversationId/read`.
- [ ] Call read endpoint when selected conversation changes and update local/realtime state.

### Task 3: Start Conversation From Contact

**Files:**
- Modify: `apps/api/src/modules/contacts/contacts.service.ts`
- Modify: `apps/api/src/modules/contacts/contacts.routes.ts`
- Modify: `apps/api/src/modules/contacts/contacts.service.test.ts`
- Modify: `apps/web/src/app/api.ts`
- Modify: `apps/web/src/features/contacts/ContactsPage.tsx`
- Modify: `apps/web/src/features/shell/TalkSuiteShell.tsx` if needed for module handoff.

- [ ] Add `POST /contacts/:contactId/conversations` with `channelId`.
- [ ] Reuse existing conversation for the contact/channel or create a new open one.
- [ ] Add a contact drawer action that starts the conversation and navigates to atendimento.

### Task 4: Simple Tags

**Files:**
- Modify: `apps/api/src/modules/conversations/conversations.routes.ts`
- Modify: `apps/api/src/modules/conversations/conversations.service.ts`
- Modify: `apps/api/src/modules/conversations/conversations.service.test.ts`
- Modify: `apps/web/src/app/api.ts`
- Modify: `apps/web/src/features/inbox/InboxPage.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] Extend conversation actions with `add_tag` and `remove_tag`.
- [ ] Upsert tag by trimmed name and link/unlink conversation tags.
- [ ] Add tag input and remove buttons in the atendimento context card.

### Task 5: Verification

**Files:**
- No source edits unless verification finds defects.

- [ ] Run `pnpm --filter @prymeira-talk/api test`.
- [ ] Run `pnpm --filter @prymeira-talk/web test`.
- [ ] Run `pnpm --filter @prymeira-talk/api build`.
- [ ] Run `pnpm --filter @prymeira-talk/web build`.
- [ ] Open localhost and verify contact start, read badge clearing, tag add/remove, and no realtime fallback names.
