ALTER TYPE "ChannelProvider" ADD VALUE 'meta_cloud';

ALTER TABLE "conversations"
  ADD COLUMN "customer_service_window_expires_at" TIMESTAMP(3);

CREATE TABLE "meta_message_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" TEXT NOT NULL,
    "waba_id" TEXT NOT NULL,
    "template_id" TEXT,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "components" JSONB NOT NULL DEFAULT '[]',
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meta_message_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "meta_message_templates_workspace_id_waba_id_name_language_key" ON "meta_message_templates"("workspace_id", "waba_id", "name", "language");
CREATE INDEX "meta_message_templates_workspace_id_status_idx" ON "meta_message_templates"("workspace_id", "status");
