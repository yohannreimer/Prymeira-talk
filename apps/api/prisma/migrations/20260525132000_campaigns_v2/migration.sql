ALTER TABLE "campaigns"
  ADD COLUMN "templates" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "fallback_name" TEXT NOT NULL DEFAULT 'cliente',
  ADD COLUMN "cadence" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "campaign_recipients"
  ALTER COLUMN "contact_id" DROP NOT NULL,
  ADD COLUMN "audience_key" TEXT,
  ADD COLUMN "provider_message_id" TEXT,
  ADD COLUMN "contact_snapshot" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "scheduled_at" TIMESTAMP(3),
  ADD COLUMN "sent_at" TIMESTAMP(3),
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "error_message" TEXT;

UPDATE "campaign_recipients"
SET "audience_key" = "contact_id"::TEXT
WHERE "audience_key" IS NULL AND "contact_id" IS NOT NULL;

CREATE UNIQUE INDEX "campaign_recipients_workspace_id_campaign_id_audience_key_key"
ON "campaign_recipients"("workspace_id", "campaign_id", "audience_key");
