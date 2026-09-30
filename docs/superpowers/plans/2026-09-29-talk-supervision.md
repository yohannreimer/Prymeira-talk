# Talk supervision implementation plan

> **For agentic workers:** Use subagent-driven-development for the independent Hub and web tasks; root implements and integrates the Talk authorization and queries. Track the steps below and perform spec review before code quality review.

**Goal:** A read-only supervisor inbox aggregates existing seller accounts, preserving their next-action and unread states.

**Architecture:** Hub owns explicit customer/workspace/channel grants, validates active seller access and audits administrative changes. Every Talk supervision read authenticates through Hub and applies the exact authorized workspace/channel pairs. Normal product authorization stays independent.

**Tech stack:** Fastify, Prisma/PostgreSQL, Clerk, React, TypeScript, Zod, Vitest.

## Tasks and interfaces

- [x] Hub: create supervision grant model and migration; authenticated `GET /me/talk-supervision`; admin source/channel selectors and grant create/revoke with audit. Grant wire fields: `id`, `supervisor_customer_id`, `seller_customer_id`, `seller_name`, `seller_email`, `workspace_id`, `channel_id`.
- [x] Talk authorization: branch only `/supervision` reads to live Hub grants, require GET, reject missing/empty/malformed authorization; validate admin channel discovery through `/admin/session`. Never set a seller `request.talk` context for a supervisor.
- [x] Talk queries: `GET /supervision/summary`, `GET /supervision/conversations?status=active|closed|all&sellerCustomerId=UUID&nextAction=true|false&unread=true|false&cursor=opaque`; thread and media under `/supervision/workspaces/:workspaceId/conversations/:conversationId`. Validate scope before histories, cursors, cached media or PDF previews. Summary counts the whole visible active queue, not the current page. Lists fetch 51 rows to return 50 plus a stable continuation cursor.
- [x] Shared: export the existing persistent handoff predicate as `needsHumanAttention`, retain `handoffActionCompletedAt`, and reuse the existing SQL handoff and unread conditions for seller and supervisor queries.
- [x] Web: dedicated `?module=supervisao` read-only screen; summary table clickable cells, independent seller/next-action/unread/status filters, joined inbox and media reader. Revalidate every 15 seconds only while visible, abort stale reads and clear revoked/inaccessible data. Keep supervisor reads free of read acknowledgements and transcription writes.
- [x] Hub web: show separate supervision entry even without own Talk entitlement; preserve normal product lock behavior.
- [x] Verification: tests for handoff completion, unread preservation, filter intersections, counts beyond 50, pagination, scope forgery, cached media after revocation, GET-only boundaries, Hub timeout/error and admin/channel validation. Run relevant Vitest suites, both typechecks and web builds; inspect the resulting UI and diff.

## Acceptance defaults

Initial filters are all sellers, active conversations, next action on, unread off. Indicators count conversations. User links remain unchanged. No follow-up counters, alternate unanswered predicate, sending, notes, transfers or new billing model. Admin source catalog uses the Talk API's authenticated `GET /supervision/admin/channels?workspaceId=UUID`.

## Verification commands

Talk: `pnpm --filter @prymeira-talk/api exec vitest run src/modules/supervision src/app.test.ts`; `pnpm --filter @prymeira-talk/web test`; `pnpm typecheck`; `pnpm --filter @prymeira-talk/web build`.

Hub: `pnpm --filter @prymeira/account-api test`; `pnpm typecheck`; `pnpm --filter @prymeira/hub-web build`. Generate Prisma clients in isolated checkouts; apply migrations to a disposable test database only.
