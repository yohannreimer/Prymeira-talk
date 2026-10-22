ALTER TABLE "ctwa_conversion_events" ADD COLUMN "order_hash" VARCHAR(64);
CREATE UNIQUE INDEX "ctwa_conversion_events_order_key" ON "ctwa_conversion_events"("workspace_id", "channel_id", "order_hash");
