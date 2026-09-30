ALTER TABLE "campaign_prospecting_reservations"
  ADD COLUMN "latest_inbound_message_id" UUID,
  ADD COLUMN "latest_inbound_at" TIMESTAMP(3);
