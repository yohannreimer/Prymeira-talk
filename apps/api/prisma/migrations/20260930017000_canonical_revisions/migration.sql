-- AlterTable
ALTER TABLE "canonical_message_identities" ADD COLUMN     "content_state" TEXT NOT NULL DEFAULT 'ready',
ADD COLUMN     "revision_version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "canonical_actions" ADD COLUMN     "action_hash" VARCHAR(64),
ADD COLUMN     "action_tuple" JSONB;

-- CreateIndex
CREATE INDEX "canonical_actions_workspace_id_channel_id_identity_id_actio_idx" ON "canonical_actions"("workspace_id", "channel_id", "identity_id", "action_hash");
