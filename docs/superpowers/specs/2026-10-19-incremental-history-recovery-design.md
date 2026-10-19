# Incremental WAHA recovery

Authorized scope: recover missed messages without exhaustive old-history reads or silently skipping incomplete work.

Use the pinned GOWS 2026.9.1 global messages endpoint with inclusive timestamp bounds and ascending timestamp order. Fixed windows advance the existing recoveredThroughAt by at most five minutes, with the existing ten-minute overlap. No getChats scan is required. Never fall back to an unfiltered scan when the optimized provider contract is unsupported.

Persist scan metadata on ChannelConnection: window bounds, expected checkpoint and lifecycle generation, page offset, page digests for consistency verification, exclusive lease and retry time. No message body is stored in the cursor. Canonical persistence precedes page progress; a crash in between replays idempotently. A new process resumes the same window. Two identical exhausted passes certify the interval; changed pages are persisted again and verification restarts. Identical verification pages need no duplicate canonical writes. Only a fenced compare-and-set on the unchanged physical connection/checkpoint can advance global coverage. Lease expiry, generation changes, normalization holds, oversized responses and provider failures cannot advance coverage.

Bound work per invocation by page count and wall time between pages. Back off failures, yield unfinished windows, and retain coverage until completion. Live webhook delivery remains independent. Date filters are checked on every returned non-notice message; an adapter ignoring them fails closed. GOWS capability is checked explicitly. Existing Evolution recovery is unchanged.

Verification: transport query contract, bounded requests independent of ancient history, >50 messages and timestamp ties, resume after restart/partial persistence, mutation during pagination, rejected filters, repeated pagination, normalization holds, concurrent leases and generation changes. Owned PostgreSQL verifies fencing and durable restart. This preserves messages available in the provider within the existing recovery horizon; it cannot restore bytes absent from WhatsApp/provider storage.
