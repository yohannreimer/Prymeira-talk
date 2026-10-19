# Incremental history recovery implementation plan

Goal: bounded, durable time-window recovery on GOWS without full history polling.

1. Add regression tests for the GOWS filtered global query and durable recovery state machine; run them red.
2. Add additive nullable recovery cursor/lease/retry columns to ChannelConnection and a migration; generate Prisma client.
3. Add a GOWS-only filtered recovery method to waha.client.ts. Reject unsupported engines rather than using an unfiltered fallback.
4. Implement waha-history-recovery.ts with fixed windows, bounded pages, durable metadata, canonical persistence-before-progress, page digest verification and fenced checkpoint advancement. Wire the actual WAHA client through provider-history.ts; retain legacy helpers for older adapters/tests, never as fallback on a production optimized-method failure.
5. Run targeted tests, owned PostgreSQL restart/fencing/normalization checks, API typecheck and build; inspect scoped diff. Validate migration against an owned database and existing canonical integration suites.
6. Commit the verified candidate, create a draft PR and run the repository CI. Publish/deploy the validated worker correction only if the production checks and release process permit it. Report actual state and any remaining limitation.

Review: no checkpoint movement on missing/held/unverified data, no provider calls inside SQL transactions, no message payloads in cursor, and no changes to live send/agent behavior.
