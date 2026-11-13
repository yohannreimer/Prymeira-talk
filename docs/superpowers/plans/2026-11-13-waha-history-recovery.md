# WAHA history recovery implementation plan

**Goal:** Recover Vendas 03 recent history without restarting WhatsApp or changing live sending/receiving.

**Observed cause:** The worker reports `HISTORY_CANONICAL_HOLD`. Ten recovered receipts from 22 October differ from earlier receipts exclusively in `pushName`; exact keys, content, revisions, mappings and source agree. The failed page is retried without advancing its durable cursor. The initial import flag dates from 5 October, so reconnecting does not rerun that import.

**Architecture:** Treat `pushName` as presentation only for WAHA history/recovery receipts. Repair an existing false hold only when all other facts match, then replay through the current trusted canonical transaction. Keep live receipt handling, contradictory mappings, edits and changed content unchanged. Backfill the recent fifteen-day interval in a separate bounded operator process using history mode; preserve the older recovery frontier until its original interval is verified.

**Tech stack:** TypeScript, Prisma, PostgreSQL, Vitest, existing WAHA pagination metadata.

- [x] Add PostgreSQL regression cases to `canonical-store.postgres.test.ts`: renamed history receipt, persisted false holds across reconnect generations, preserved changed content and address conflicts, preserved live semantics.
- [x] Run the new cases against an owned loopback `messaging_test` database and observe the failures.
- [x] Update `canonical-store.ts` history-only envelope comparison and narrowly guarded repair, retaining immutable receipt payloads and resolution evidence.
- [x] Run canonical store, reducers, provider history, gap recovery, ingestion and outbound regression suites; typecheck and build.
- [x] Add a scoped dry-run-by-default operator backfill command. Validate provider ownership, physical generation, fixed date bounds and exact pagination; write only in history mode, without agents or outbound actions. Do not skip the existing checkpoint.
- [ ] Verify the exact production artifact and baseline health. Apply the tested correction/repair to history processing only, then recover recent history with bounded resource use.
- [ ] Compare source rows against persisted exact identities, record unresolved items, and verify continued live traffic and WAHA `WORKING` without a session restart.

No transcripts, credentials, phone numbers or QR contents belong in this plan or shared reports. The observed source scope is the existing Vendas 03 connection; authorization is the user's explicit repair request.

Observed during the bounded import: two location receipts differ only by 3.552713678800501e-15 degrees after the JSONB/provider roundtrip. Compare coordinate values within one relative floating-point rounding unit only for history/recovery receipts; preserve saved coordinates on false-hold replay. A regression must demonstrate real movement remains held. Historical messages with genuinely different text remain pending unless native revision evidence establishes authority.
