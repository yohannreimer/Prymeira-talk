ALTER TABLE "campaign_prospecting_reservations" ADD COLUMN "dispatch_intent_at" TIMESTAMP(3);
-- Existing in-flight deliveries stay fenced after upgrade. Their old timestamp
-- was the prior authorization boundary; never reinterpret them as prepared.
UPDATE "campaign_prospecting_reservations" SET "dispatch_intent_at" = "dispatch_started_at"
WHERE "status" IN ('sending', 'confirmed', 'uncertain') OR "confirmed_at" IS NOT NULL;
