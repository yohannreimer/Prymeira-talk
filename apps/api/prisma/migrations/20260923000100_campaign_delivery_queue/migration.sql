ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'paused';
ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'canceled';
ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'needs_attention';

ALTER TABLE "campaigns"
  ADD COLUMN "activation_key" TEXT,
  ADD COLUMN "confirmed_by" TEXT,
  ADD COLUMN "confirmed_at" TIMESTAMP(3),
  ADD COLUMN "channel_id" UUID,
  ADD COLUMN "start_mode" TEXT,
  ADD COLUMN "time_zone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo';

ALTER TABLE "campaign_recipients"
  ADD COLUMN "phone_snapshot" TEXT,
  ADD COLUMN "channel_id" UUID,
  ADD COLUMN "sequence_number" INTEGER,
  ADD COLUMN "gap_seconds" INTEGER,
  ADD COLUMN "pause_seconds" INTEGER,
  ADD COLUMN "lease_token" UUID,
  ADD COLUMN "lease_expires_at" TIMESTAMP(3),
  ADD COLUMN "verified_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "campaigns_workspace_id_activation_key_key"
  ON "campaigns"("workspace_id", "activation_key");
CREATE UNIQUE INDEX "campaign_recipients_workspace_id_campaign_id_sequence_number_key"
  ON "campaign_recipients"("workspace_id", "campaign_id", "sequence_number");
CREATE INDEX "campaign_recipients_status_scheduled_at_idx"
  ON "campaign_recipients"("status", "scheduled_at");
CREATE INDEX "campaign_recipients_workspace_id_channel_id_status_idx"
  ON "campaign_recipients"("workspace_id", "channel_id", "status");

CREATE TABLE "campaign_channel_throttles" (
  "workspace_id" TEXT NOT NULL,
  "channel_id" UUID NOT NULL,
  "next_available_at" TIMESTAMP(3),
  "attempts_since_pause" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "campaign_channel_throttles_pkey" PRIMARY KEY ("workspace_id", "channel_id")
);
