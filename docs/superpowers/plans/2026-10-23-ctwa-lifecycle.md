# CTWA Meeting and Sale Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development. Execute the cross-repository lifecycle extension as one integration task; specification review precedes quality review. No live event sends during implementation.

**Goal:** Record confirmed meetings and owner-confirmed BRL sales from only the enabled workspace through existing Tracking, preserving exactly-once downstream claims and the original lead row.

**Architecture:** Follow design.md. Preserve version 1 and its D1 lead table. Add version 2 lifecycle receipts and a separate D1 lifecycle fence. Talk captures trusted Calendar results, recovers missed captures through scoped read-only reconciliation and accepts authenticated owner manual sales. The existing bridge exports durable facts; Tracking alone sends Meta QualifiedLead/Purchase.

**Tech Stack:** TypeScript/Fastify/Prisma/PostgreSQL; React/Vitest; Cloudflare Pages JavaScript/D1; Meta CAPI v25.

## File responsibilities

Talk: attribution/ctwa-lifecycle service and tests (trusted fact preparation and conflict handling); ctwa-payload/service (shared event identities and provenance); ctwa-tracking-config/bridge (explicit lifecycle gating and durable forwarding); ctwa.routes (owner-only status/sales); agent-runtime and app composition (Calendar success capture); meeting-scheduler (createdAt and scoped lookup); new Prisma migration/schema (provenance and uniqueness); inbox/CtwaLifecyclePanel and API client/tests (manual sale workflow, honest receipt states). Add small dedicated modules instead of enlarging existing runtime/UI files unnecessarily.

Tracking: functions/lib/ctwa-contract (v2 validation and immutable identity), ctwa-meta (event-specific payload), api/integrations/talk-ctwa (separate stage storage/parent scope/CAS), new D1 migration, api/leads and dash/index (stage details without extra lead rows), tests/ctwa bridge/runtime suites.

## Integration task

- [ ] Establish red tests for legacy v1 compatibility and lifecycle gating before implementation. Required assertion examples: disabled workspace => no DB event or network; unauthorized role => 403; reused sale reference with changed cents => conflict and no send; confirmed Calendar booking => exactly one QualifiedLead at confirmation time, reschedule => same event; unavailable booking => no event.
- [ ] Implement the exact version 2 contract in design.md. Money is purchase {orderId, valueCents, currency}; sourceReference is a 64-hex hash. LeadEventId binds all native scope to the existing lead. Parent mismatch fails before Meta; absent parent is retryable. Keep v1 object shape/identity stable.
- [ ] Add independent D1 lifecycle table and tests against real workerd/D1 CAS. Cover simultaneous duplicates, one meeting per conversation, one sale reference per workspace across channels, immutable fields, positive cents, conditional money fields, terminal uncertainty and old accepted lead preservation.
- [ ] Implement Talk provenance/unique constraints and scoped manual-sale/Calendar lifecycle service. Do not make legacy manually prepared rows automatically eligible. New owner endpoint derives workspace/user from authentication. Freeze original attribution and occurrence time; never accept either from form fields.
- [ ] Wire confirmed Calendar capture and bounded read-only recovery after activation timestamp. Test source timestamps, private conversation binding, before-activation exclusion and first confirmed milestone replay without Calendar mutations. Capture failures must leave actual booking intact.
- [ ] Extend worker and bridge to trusted, enabled lifecycle rows, retaining unchanged signed v1 behavior and sole Tracking Meta ownership. Test other-workspace denial and reconnect/retry without second Meta calls.
- [ ] Add owner-only native-conversation sale form with required reference and pt-BR BRL amount. Keep state keyed by conversation and preserve id on uncertain/retried submission. Unit/interaction tests cover invalid/zero/negative/too-precise money, double submit and late response after switching conversation. Never change the existing É cliente action.
- [ ] Attach lifecycle details/statuses to original dashboard lead. A lead plus meeting plus sale must still yield one lead row; website lead and purchase flows stay behaviorally unchanged. No fake visits/UTMs/GA4.
- [ ] Run Tracking npm test, npm run build, git diff --check. Talk: frozen dependency installation, Prisma generation/migration on owned disposable fixtures, focused tests, API/web typecheck/build and full normal release validation. Derive exact commands from package.json; save safe logs in task directory. Do not alter test thresholds or skip required checks.
- [ ] Self-review diff against each design requirement; produce exact verification output and known limitations. No commits/push/deploy/production access by implementer; controller performs spec review then quality review and publishes only after both PASS.

## Controller release task

- [ ] Inspect current production configuration/image revisions and preserve concurrent changes. Validate official QualifiedLead support with primary documentation and, if necessary, explicitly marked test-mode events; never create a real false meeting/sale.
- [ ] Publish Tracking migration/code before Talk, run baseline counts and auth/no-send checks. Build Talk through existing exact-revision CI and verify release manifest/migration hashes. API and web update only as required; no ingress/worker/WAHA or phone changes.
- [ ] Apply normal Talk migration, deploy exact API/web revisions and preserve environment. Then set lifecycleEnabled and lifecycleEnabledAt only inside the previously approved workspace map entry. Verify health and capability isolation. Do not grant new access or replace credentials.
- [ ] Validate original accepted lead still once, owner form available only in own native conversation, no form submission or stage mutation, and no synthetic live Meta event. First real meeting/sale Meta receipt is pending until real actions occur; report this explicitly.
- [ ] Save factual local execution report per user AGENTS. Brain snapshot loaded read-only 21dbc84141ec4107afc15651bb0523ecb73700eb, remote unverified. No Brain enqueue/publication without authorization.
