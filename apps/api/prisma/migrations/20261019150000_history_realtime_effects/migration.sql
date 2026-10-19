-- Canonical history/recovery also commits presentation notifications without an
-- HTTP receipt. Keep the original receipt FK and require the same canonical
-- origin/message/conversation anchors; no autonomous business effect is allowed.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
ALTER TABLE ingress_effects DROP CONSTRAINT ingress_effects_origin_check;
ALTER TABLE ingress_effects ADD CONSTRAINT ingress_effects_origin_check CHECK (
  (receipt_id IS NOT NULL AND event_index IS NOT NULL)
  OR (
    receipt_id IS NULL AND event_index IS NULL
    AND kind IN ('media.prepare', 'realtime.message', 'realtime.conversation')
    AND COALESCE(cause->>'origin', '') = 'canonical_history'
    AND conversation_id IS NOT NULL AND message_id IS NOT NULL
  )
) NOT VALID;
COMMIT;

-- Validate separately: this lock permits ordinary INSERT/UPDATE/DELETE. If it
-- fails, the new-write constraint is already enforced; inspect the migration
-- ledger and resolve/retry validation before marking the release gate complete.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE ingress_effects VALIDATE CONSTRAINT ingress_effects_origin_check;
COMMIT;
