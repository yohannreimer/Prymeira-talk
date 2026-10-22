# WAHA CTWA release and first-lead validation plan

> For agentic workers: use subagent-driven-development with independent specification and quality review. User explicitly authorized module deployment and this lead's Meta send on 2026-10-22. Production access remains limited to this rollout and this lead.

**Goal:** deploy the reviewed CTWA module on the current production baseline and validate one real LeadSubmitted submission.

**Architecture:** port feature commit 3631ede2f7e50f53c67dd2e774b9f4244619f655 onto observed API production 5b9f4dd80f8c19f731ea4dc3710d3a7d6369fa25. Preserve the current release workflow and messaging semantics. Add an explicit dry-run-first operator command for a receipt accepted before deployment; it prepares only attribution/LeadSubmitted and never replays ingress or messaging effects. Meta dispatch retains atomic state/attempt fencing and exact workspace configuration.

**Tech stack:** existing TypeScript/Fastify/Prisma, PostgreSQL/RabbitMQ synthetic fixtures, pinned release CI, Portainer.

## Implementation

- [ ] Port the bounded extractor, optional normalized field, scoped tables/migrations, accepted-ingress capture, authenticated manual routes and per-workspace disabled-default sender. Preserve current app/env/schema/workflow changes; add CTWA_TEST_DATABASE_URL to the current validation map.
- [ ] Add `ctwa-receipt-import.ts`, tests and a compiled `prepare-ctwa-receipt` operator entry. Required workspace/receipt/event index; default dry run, explicit `--apply` for writes. Read digest-verified raw and normalized blobs from private ingress storage. Require an authenticated WAHA live receipt, exact stored/new normalized native message key, applied progress, matching workspace/channel/conversation/message and inbound non-reset individual message. Do not require a current provider generation for historical attribution proof. Reject mismatches without writes. Create one scoped attribution and pending LeadSubmitted with original event time; preserve immutable existing ownership/time and refuse click conflicts. No network, canonical message writes, effects, replay, resets or state-unfencing. Output only technical safe IDs/counts/state, never raw click/token/body.
- [ ] Unit/PostgreSQL tests must exercise invalid digest/scope/key/state, hidden messages, concurrent/idempotent preparation, disabled sender and uncertain retry fencing. Use only owned synthetic fixtures. No real customer data in GitHub.
- [ ] Update operator guide for authorized receipt preparation and maintain failure/rollback boundaries.
- [ ] Independent spec review, then quality review. Resolve issues before final candidate.

## Release and deployment (root only)

- [ ] Run fresh install/generate, focused tests/typecheck/build and supported full exact-revision validation (owned fixture or CI); retain provider container contract and immutable manifest. Publish only the exact validated candidate. Do not weaken a failing gate or replace production with the earlier diagnostic branch.
- [ ] Inventory current API/ingress/worker images, applied migrations, flags, pending/held/uncertain baseline and existing Meta asset/config availability with secrets suppressed. Keep rollback digests and unrelated services/config unchanged.
- [ ] Apply only missing additive CTWA migrations, update selected Talk components to the validated digest, verify service convergence, health/ready, provider/receipt safety baseline and feature routes. Keep Meta sending disabled while validating capture.
- [ ] For the identified lead, dry-run then explicitly prepare from its original applied WAHA receipt. Verify one event, original time and no duplicate/reparent. Configure only its authorized workspace using existing secret infrastructure after asset verification.
- [ ] Submit once through fenced sender; record Meta HTTP/events_received acceptance and inspect Meta reception separately from campaign attribution. On sending/unknown, stop automatic attempts and preserve state. Do not invent missing assets or create new credentials/permissions without required authorization.
- [ ] Save a factual local task report, verify actual publication/closure state and leave canonical task state untouched. Brain publication only within current authorization; no private payloads or credentials.
