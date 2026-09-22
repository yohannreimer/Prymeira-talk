-- Follow-up invalidation must use durable server arrival order rather than
-- provider timestamps, which can be second-precision or arrive out of order.
ALTER TABLE "conversation_followups" ADD COLUMN "anchor_ingested_at" TIMESTAMP(3);

-- Existing follow-ups normally point to messages with an arrival timestamp.
-- For the historical NULL case, use the follow-up's own persisted creation
-- time instead of the provider-facing message timestamp.
UPDATE "conversation_followups" AS "followup"
SET "anchor_ingested_at" = COALESCE("message"."ingested_at", "followup"."created_at")
FROM "messages" AS "message"
WHERE "message"."workspace_id" = "followup"."workspace_id"
  AND "message"."id" = "followup"."anchor_message_id"
  AND "followup"."anchor_ingested_at" IS NULL;

ALTER TABLE "conversation_followups" ALTER COLUMN "anchor_ingested_at" SET NOT NULL;
