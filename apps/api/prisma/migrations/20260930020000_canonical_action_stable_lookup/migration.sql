-- The indexed action bucket excludes mutable chat/sender roots. Readers must
-- compare all immutable tuple fields and current roots from the target identity.
ALTER TABLE "canonical_actions" ADD COLUMN "action_lookup_hash" VARCHAR(64);
CREATE INDEX "canonical_actions_workspace_id_channel_id_action_lookup_has_idx"
ON "canonical_actions" ("workspace_id", "channel_id", "action_lookup_hash");

-- Only derived action caches are backfilled. Original observations/certificates,
-- message identities, UUIDs and all legacy indexes remain intact.
UPDATE "canonical_actions"
SET "action_lookup_hash" = encode(sha256(convert_to(concat('[', action_tuple->3, ',', action_tuple->4, ',', action_tuple->5, ']'), 'UTF8')), 'hex')
WHERE jsonb_typeof(action_tuple) = 'array';
