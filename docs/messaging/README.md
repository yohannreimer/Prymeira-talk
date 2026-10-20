# Messaging reference

This is the current source map and invariant checklist. Read it before changing the critical paths below. Earlier rollout notes are historical; their full scans, WPP fallback and inline callbacks do not define the current recovery contract.

| Concern | Sources |
| --- | --- |
| Authenticated receipt and transport | `apps/api/src/modules/ingress/{http,journal,broker,runtime}.ts` |
| Canonical application and effects | `apps/api/src/modules/ingress/{application,effect-runner,effect-handlers}.ts` |
| Native identity and transaction entry | `apps/api/src/modules/messaging/{whatsapp-identity,canonical-store,canonical-boundary}.ts` |
| Outbound proof and uncertain sends | `apps/api/src/modules/channels/{outbound-routing,outbound-dispatch-journal}.ts`, `apps/api/src/modules/ingress/` |
| Recovery and first imports | `apps/api/src/modules/channels/{provider-history,channel-history-canonical,waha-history-recovery,evolution-history-recovery,history-recovery-budget,history-memory-budget}.ts` |
| Provider contracts | `apps/api/src/modules/{waha,evolution}/`, `infra/waha-recovery/` |
| Persisted operational observations | `apps/api/src/observability/operational-health.ts`, `apps/api/src/modules/channels/rollout-diagnostics.ts` |
| Release evidence and rollback | [release validation](../operations/release-validation.md), `apps/api/scripts/validation/` |

## Identity, transactions and delivery

Canonical identity compares the complete native key: tenant/workspace, channel, native ID, chat, direction and sender/participant where applicable. PN/LID equivalence needs evidence, including group participants. A digest is a lookup bucket; compare the full tuple. Text and timestamp are never deduplication keys. Respect group identities and tenant boundaries.

Acquire the workspace lock FIRST, then channel coordination, inside READ COMMITTED; the physical connection SHARE lock protects generation/session/phone/channel-anchor fences. Do not put network calls or a history batch in a canonical transaction. Every recovery write checks the original checkpoint and current lease as well as the source generation, session, phone and channel anchor. A changed source cannot advance old coverage.

Canonical persistence may reuse its address graph only within one `persistInTransaction` application. New addresses and redirects invalidate that operation snapshot; authority/state/source checks remain under the existing workspace boundary. Separate applications get fresh topology even inside the same SQL transaction. A second authority resolution is unnecessary only when the first has already established an operator and the intervening code is read-only under that boundary. Do not introduce a process, workspace or transaction-wide cache. `canonical-store.postgres.test.ts` enforces the stable-path query budget, mutation invalidation, and later-application freshness. The graph still reads the scoped channel metadata once: this does not establish capacity for arbitrary address counts.

A durable HTTP receipt, a RabbitMQ reference/ACK, canonical application, durable effect completion, and external delivery proof are separate facts. SQL receipt/delivery states do not count Rabbit dead references. Failed attempts are historical totals, not current failures. An uncertain send remains fenced for review and never triggers an automatic resend. Journal failures must retain the delivery fence; a rollback cannot clear uncertainty.

The production reconciliation cutoff is **2026-10-19T13:31:31.133Z**. Older reconciliation was abandoned. No migration, certification, reset or qualification may reset that baseline, discard coverage or replay that abandoned history. Verified recovery can advance forward in bounded windows.

## Provider and topology contract

WAHA filtered recovery is qualified only for the pinned **GOWS 2026.9.1 recovery shim** in `infra/waha-recovery`. WPP event normalization remains readable; WPP is not a supported filtered-recovery fallback. Retain the pinned real-container contract CI job. Local native fixtures do not qualify a provider image.

Evolution **2.4.0-rc.2** source is pinned at `5624bdaea81c58e4db60fe2a3a8de7c48bba1e60`, Baileys blob `26c4df68b5b41483f2a1082c6d80a9e3f7a5d415`. It supports ISO `gte`/`lte` filters and descending results. The new reader requires one bounded batch, maximum 5,000 rows, exact total/currentPage/terminal declarations, and fails closed on drift or incomplete metadata. This run inspected official source and synthetic contracts; it did not qualify the real Evolution image.

| Topology | Expected behavior | Evidence boundary |
| --- | --- | --- |
| Both eligible, same verified phone | Canonical duplicates merge; one outbound writer | Synthetic PostgreSQL/HTTP/Rabbit tests; provider image qualification remains separate |
| Only Evolution eligible | Evolution remains usable; recovery needs its bounded contract | Synthetic tests and official source contract |
| Only WAHA eligible | Same-phone GOWS remains usable and recoverable | Synthetic tests and pinned GOWS adapter CI contract |
| Both down | Durable receipts/effects remain pending; no safe writer is reported | Persisted observations do not prove live provider health |
| Provider returns | Recheck phone/generation/anchor; resume metadata and idempotently reconcile | Synthetic lease/restart/fencing tests; no live WhatsApp certification here |

Both providers share the VPS, PostgreSQL and broker. Redundancy is not full high availability.

## Recovery limits and remaining limits

A sweep has a **5 s work budget**, including discovery, plus bounded cleanup; each connection has at most **4 page reads / 100 canonical items** per turn. Canonical transactions have a **500 ms** ceiling; pool acquisition and locks have **250 ms** limits. The **8 MiB** budget bounds logical retained cursor + page + identities, not process RSS. WAHA also probes engine version once per page read (up to 8 HTTP calls for 4 pages); unresolved LID lookups add calls inside the same work deadline. Response bodies are limited to **4 MiB WAHA / 16 MiB Evolution**.

Evolution windows with more than 5,000 rows in one chat, or retained metadata/page/identities exceeding 8 MiB, remain pending and fail closed. These bounds do not guarantee catch-up at arbitrary message density.

Cursors retain metadata only, with fixed **5 min windows / 10 min overlap / 30 s settlement**. Coverage advances after two equal exhausted passes. Partial canonical progress survives process restart; pagination counter drift restarts the pass without silently advancing. Durable next-attempt scheduling gives untouched/earliest-due connections a turn. Held normalization keeps the window pending.

Recovery creates existing `media.prepare` obligations. Presentation work uses existing durable realtime effects and requires `EFFECTS_ENABLED`. Recovery never invokes inline callbacks or creates autonomous historical business effects. Receipt-backed live business effects retain their existing behavior.

First imports retain their existing finite **15 days / 300 chats / 30 messages per chat** limits. They are not resumable and do not share the sweep deadline; do not describe all background work as bounded by the new recovery budget.

## Provisional rollout observations

Capture workspace-scoped baseline and deltas before enabling recovery: pending SQL receipts/applications/effects, oldest age, message-held versus control/unclassified-held, current failed effects, outbound uncertainty, application latency, checkpoint lag, consecutive recovery failures, lease/backoff state, CPU and RSS. Diagnostics select no cursor payload. These are persisted observations, not runtime health or a completeness audit. Legacy holds may already degrade overall health; preserve the baseline rather than claiming every hold is new or zero.

Provisional stop criteria: any new autonomous historical effect, cross-tenant row, missing/duplicate oracle identity or uncertain automatic resend stops immediately. At the controlled target of 8 canonical messages/s (16 envelopes/s), require ingress p95 <500 ms and application p95 <2 s. Stop rollout if new message-held or current failures increase above baseline, pending backlog grows for two consecutive 5 min windows, checkpoint lag increases for two windows while eligible, leases remain expired for two windows, or CPU stays >80% / RSS grows >25% above the captured steady baseline for 10 min. Record sample interval and workload; these resource thresholds are provisional, not capacity certification. Investigate failures/backoff rather than repeatedly resetting checkpoints.
