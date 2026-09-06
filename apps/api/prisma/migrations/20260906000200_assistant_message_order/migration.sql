-- Existing messages retain their historical order (NULL falls back to created_at).
-- New messages use server arrival time, not WhatsApp's second-precision timestamp.
ALTER TABLE "messages" ADD COLUMN "ingested_at" TIMESTAMP(3);
ALTER TABLE "messages" ALTER COLUMN "ingested_at" SET DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX "messages_assistant_context_order_idx" ON "messages" ("workspace_id", "conversation_id", "ingested_at" DESC NULLS LAST, "created_at" DESC);
