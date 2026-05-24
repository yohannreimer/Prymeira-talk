# Contact Board Complete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a complete contact board UI with board creation, stage administration, contact assignment, movement, and removal.

**Architecture:** Extend the existing boards API rather than creating a separate module. The React contacts page keeps board state locally after mutations and reloads only when needed. Shared realtime schemas gain a membership deletion event so other open clients can refresh board membership state.

**Tech Stack:** Fastify, Prisma, Zod, React, DnD Kit, Vitest.

---

### Task 1: Backend Board Administration

**Files:**
- Modify: `apps/api/src/modules/boards/boards.service.ts`
- Modify: `apps/api/src/modules/boards/boards.routes.ts`
- Modify: `packages/shared/src/realtime.ts`
- Test: `apps/api/src/modules/boards/boards.service.test.ts`

- [ ] Add service methods for board update/delete, stage update/delete/reorder, and membership removal.
- [ ] Add route schemas and HTTP handlers for the new methods.
- [ ] Return 409 for deleting a non-empty stage.
- [ ] Publish `board_membership.deleted` when removing a contact from a board.
- [ ] Cover service and route behavior with focused tests.

### Task 2: Web API Client

**Files:**
- Modify: `apps/web/src/app/api.ts`
- Test: `apps/web/src/app/api.test.ts`

- [ ] Add client functions for every new board endpoint.
- [ ] Parse returned board, stage, membership, and delete payloads with existing Zod schemas.
- [ ] Add tests asserting HTTP method, URL, and body for the new client helpers.

### Task 3: Board UI

**Files:**
- Modify: `apps/web/src/features/contacts/ContactsPage.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] Replace API-only empty states with creation controls.
- [ ] Add board create/edit/delete controls.
- [ ] Add stage create/edit/delete/reorder controls.
- [ ] Add contact removal from board cards.
- [ ] Keep drag/drop and arrow movement for contact cards.
- [ ] Refresh local board state after each successful mutation.

### Task 4: Verification

**Commands:**
- `pnpm --filter @prymeira-talk/shared test`
- `pnpm --filter @prymeira-talk/api test`
- `pnpm --filter @prymeira-talk/web test`
- `pnpm --filter @prymeira-talk/api build`
- `pnpm --filter @prymeira-talk/web build`

- [ ] Run all commands and fix any regressions.
- [ ] Commit and push the completed branch.
