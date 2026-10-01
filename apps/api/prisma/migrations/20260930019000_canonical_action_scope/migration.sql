-- CreateIndex
CREATE INDEX "canonical_actions_workspace_id_channel_id_action_hash_idx" ON "canonical_actions"("workspace_id", "channel_id", "action_hash");
