ALTER TABLE "campaigns" ADD COLUMN "hide_from_inbox_until_reply" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "conversations" ADD COLUMN "hidden_until_reply" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "conversations" ADD COLUMN "last_message_preview_at" TIMESTAMP(3);

CREATE INDEX "conversations_workspace_hidden_status_activity_idx"
  ON "conversations"("workspace_id", "hidden_until_reply", "status", "last_message_at");

CREATE INDEX "campaign_recipients_workspace_id_provider_message_id_idx"
  ON "campaign_recipients"("workspace_id", "provider_message_id");
