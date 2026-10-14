-- AlterTable
ALTER TABLE "canonical_native_aliases" ADD COLUMN     "lookup_hash" VARCHAR(64);

-- AlterTable
ALTER TABLE "canonical_actions" ADD COLUMN     "native_target_hash" VARCHAR(64);

-- CreateIndex
CREATE INDEX "canonical_native_aliases_workspace_id_channel_id_lookup_has_idx" ON "canonical_native_aliases"("workspace_id", "channel_id", "lookup_hash");

-- CreateIndex
CREATE INDEX "canonical_actions_workspace_id_channel_id_native_target_has_idx" ON "canonical_actions"("workspace_id", "channel_id", "native_target_hash", "state", "id");

-- A aliases already carry complete provider/connection/session/native tuples.
-- Legacy object snapshots deliberately remain unindexed until explicit adoption.
UPDATE "canonical_native_aliases"
SET "lookup_hash" = encode(sha256(convert_to(concat('[', full_tuple->1, ',', full_tuple->2, ',', full_tuple->3, ',', full_tuple->4, ']'), 'UTF8')), 'hex')
WHERE jsonb_typeof(full_tuple) = 'array';
