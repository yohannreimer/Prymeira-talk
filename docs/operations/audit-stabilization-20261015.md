# Audit stabilization rollout — 15 October 2026

This release addresses TALK-01 through TALK-20. A valid WAHA writer keeps the logical channel connected while Evolution is offline, being repaired, or absent. First-provider WAHA onboarding establishes an authenticated immutable phone anchor. Changed provider identities, ambiguous ownership, uncertain sends and interrupted business actions remain fenced for review.

Validation is enforced by `publish-images.yml` for the exact revision. The local harness exercises real disposable PostgreSQL/RabbitMQ and loopback provider implementations; it does not certify the running production engine, credentials or deployment configuration. See `release-validation.md` for immutable image selection and the generated manifest.

## Required rollout sequence

1. Record the current API, web, ingress and worker digests/commands, effective rollout settings and applied migration state. Preserve a recoverable database backup and the previous service definitions.
2. Run the read-only `inspectPhysicalSessionOwnership` preflight using the target application's database. Resolve logical/physical collisions before enabling sends. Existing unclaimed Evolution sessions are attested only from their exact enabled workspace webhook and secret; never adopt a name or replace a foreign webhook to manufacture ownership.
3. Drain in-flight legacy form submissions and stop the old business execution loops before starting the new ones. This includes API schedulers and application/effect workers that can execute automations or AI actions. Keep durable ingress reception/transport available where its deployment permits it, so accepted events can queue. Do not run old claimless automation executors alongside the new durable executor.
4. Apply migrations once with the candidate API image before starting candidate API/workers: `20261015160000_audit_identity_and_history_media`, `20261015161000_audit_automation_and_dispatch`, `20261015162000_channel_messaging_identity`, `20261015163000_crm_lead_sync`, and `20261015164000_journal_template_dispatch`.
5. Update API, ingress and worker to the same validated API digest and web to its matching validated digest. Preserve their actual commands, networks, volumes, provider secrets and workspace allowlists. The workflow publishes images; it does not deploy a stack.
6. Confirm service revisions/digests, migrations, `/health`, `/ready` and authenticated `/operations/health`. Check broker/consumer progress separately: a historical queue confirmation is not a live worker heartbeat.
7. Inspect channels and inbox using existing sessions. A valid WAHA-only channel must display connected with 1 of 2 physical sessions and remain usable for human replies, campaigns, leads, AI, automations and follow-ups. Do not disconnect sessions or send customer messages for a smoke test. Use an explicitly designated test recipient if a real-provider delivery test is required.
8. Review existing uncertain dispatches, legacy interrupted automation/AI runs and CRM lead/note uncertainty. This release intentionally does not replay effects whose external outcome cannot be proved. Resolve them from actual provider evidence.

## Configuration checks

Verify `WAHA_ENABLED`, `WAHA_ROLLOUT_WORKSPACES`, `OUTBOUND_ROUTER_ENABLED`, `CHANNEL_HEALTH_MONITOR_ENABLED`, `CANONICAL_HISTORY_IMPORT_ENABLED`, `LEGACY_WEBHOOK_DELEGATED_WORKSPACES`, `EFFECTS_ENABLED`, `REALTIME_BRIDGE_ENABLED`, `INGRESS_TRANSPORT_STAGE`, `INGRESS_NAMESPACE`, `INGRESS_WORKSPACE_ALLOWLIST`, `INGRESS_RECOVERY_ENABLED`, `WAHA_HISTORY_IMPORT_ENABLED` and the durable media volume. Use the effective deployed values, not repository defaults. A real configured WAHA activates real messaging without activating simulated Evolution controls.

## Rollback compatibility

Stop candidate business execution loops before restoring prior executors; do not run both generations concurrently. The migrations are additive but older Prisma/runtime code may not understand history-media effects with null receipt/event anchors, automation execution checkpoints or CRM synchronization states. Pause affected consumers and preserve pending work until compatibility is verified. Do not reverse migrations, delete obligations, release uncertain sends, or clear execution checkpoints as a rollback shortcut. Restore exact prior digests only after this review and recheck actual queue progress and channel availability.

## History memory and sustained verification

Recovery scans exhaust provider pages and retain compact identities/hashes for consistency checks. WAHA payloads outside the fixed recovery window are discarded after validation; Evolution retains only payloads inside that window while still counting every provider row for exhaustion and duplicate detection. Chat scans retain projected metadata. Cross-chat comparison uses compact hashes instead of keeping serialized message bodies.

WAHA JSON responses are limited to 4 MiB while streaming, before parsing; recovery scan retention has an 8 MiB JSON budget. Exceeding a limit fails that connection's recovery without advancing its checkpoint or returning a partial history as complete. The sweep continues with other connections. A response limit after a send is still uncertain external delivery and must never authorize an automatic resend.

For an observed worker memory failure, temporarily pause only `INGRESS_RECOVERY_ENABLED` and `WAHA_HISTORY_IMPORT_ENABLED` on the worker while retaining ingress consumption and durable effects. After deploying the validated fix, restore both original values and observe the same task through multiple recovery intervals. Check memory, task stability, live receipt/application/effect progress and history error states separately; a successful initial startup is insufficient. Do not raise memory limits as a substitute for bounding retained provider data.

## Exact media identity across Evolution aliases

Evolution may store a chat by LID while its authenticated webhook identifies the explicit alternate phone number. Candidate lookup uses the native message ID in the same instance, then validates the complete key. A lookup-local native chat/sender binding requires the provider record's explicit PN/LID pair; unrelated chats, direction, participants, raw IDs, conflicting aliases and incomplete pagination remain rejected. The shared exact matcher and stored source are unchanged. Media downloads use the original native key returned by the provider.

After validating a fix for unavailable attachments, only the identified `media.prepare` obligations may be retried. Preserve receipt identities, attempt evidence and business execution checkpoints. This does not authorize replaying agent, automation, CRM or outbound-send actions.

## Retry publication reservations

RabbitMQ can deliver a reference before its publisher records confirmation and releases its durable publication reservation. A successful database handoff can still complete independently. A failed handoff waits for that reservation before publishing its replacement; expected contention from duplicate references is bounded and does not repeat the application or increment the failure counter again. The original reference is acknowledged only after confirmed replacement evidence or an existing durable handoff/dead-letter milestone. Closing the consumer interrupts the wait and lets the original channel requeue its unacknowledged reference.
