-- CreateTable
CREATE TABLE "canonical_actions" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" UUID NOT NULL,
    "observation_id" UUID NOT NULL,
    "identity_id" UUID,
    "kind" TEXT NOT NULL,
    "target_hash" VARCHAR(64) NOT NULL,
    "target" JSONB NOT NULL,
    "action_key" JSONB,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "applied_at" TIMESTAMP(3),
    "evidence" JSONB,

    CONSTRAINT "canonical_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "canonical_actions_observation_id_key" ON "canonical_actions"("observation_id");

-- CreateIndex
CREATE INDEX "canonical_actions_workspace_id_channel_id_target_hash_state_idx" ON "canonical_actions"("workspace_id", "channel_id", "target_hash", "state", "id");

-- CreateIndex
CREATE INDEX "canonical_actions_workspace_id_channel_id_state_id_idx" ON "canonical_actions"("workspace_id", "channel_id", "state", "id");

-- CreateIndex
CREATE INDEX "canonical_actions_workspace_id_channel_id_identity_id_kind_idx" ON "canonical_actions"("workspace_id", "channel_id", "identity_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_actions_workspace_id_channel_id_id_key" ON "canonical_actions"("workspace_id", "channel_id", "id");

-- AddForeignKey
ALTER TABLE "canonical_actions" ADD CONSTRAINT "canonical_actions_workspace_id_channel_id_observation_id_fkey" FOREIGN KEY ("workspace_id", "channel_id", "observation_id") REFERENCES "canonical_observations"("workspace_id", "channel_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_actions" ADD CONSTRAINT "canonical_actions_workspace_id_channel_id_identity_id_fkey" FOREIGN KEY ("workspace_id", "channel_id", "identity_id") REFERENCES "canonical_message_identities"("workspace_id", "channel_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
