-- AlterTable
ALTER TABLE "canonical_observations" ADD COLUMN     "resolution_evidence" JSONB;

-- CreateIndex
CREATE INDEX "canonical_observations_workspace_id_channel_id_identity_id__idx" ON "canonical_observations"("workspace_id", "channel_id", "identity_id", "state", "kind", "id");
