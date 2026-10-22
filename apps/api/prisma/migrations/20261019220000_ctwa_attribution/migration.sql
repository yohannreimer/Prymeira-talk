-- CreateTable
CREATE TABLE "ctwa_attributions" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "click_hash" VARCHAR(64) NOT NULL,
    "ctwa_clid" VARCHAR(2048) NOT NULL,
    "ad_id" VARCHAR(64),
    "source_mode" TEXT NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ctwa_attributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ctwa_conversion_events" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "attribution_id" UUID NOT NULL,
    "event_id" VARCHAR(80) NOT NULL,
    "event_name" TEXT NOT NULL,
    "business_key" VARCHAR(64) NOT NULL,
    "order_id" VARCHAR(128),
    "value" DECIMAL(20,4),
    "currency" VARCHAR(3),
    "event_time" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "state" TEXT NOT NULL DEFAULT 'pending_validation',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "attempted_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "response_code" INTEGER,
    "events_received" INTEGER,
    "outcome_code" TEXT,

    CONSTRAINT "ctwa_conversion_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ctwa_attributions_workspace_id_captured_at_id_idx" ON "ctwa_attributions"("workspace_id", "captured_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ctwa_attributions_workspace_id_channel_id_click_hash_key" ON "ctwa_attributions"("workspace_id", "channel_id", "click_hash");

-- CreateIndex
CREATE UNIQUE INDEX "ctwa_attributions_scoped_id_key" ON "ctwa_attributions"("workspace_id", "channel_id", "conversation_id", "message_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ctwa_conversion_events_event_id_key" ON "ctwa_conversion_events"("event_id");

-- CreateIndex
CREATE INDEX "ctwa_conversion_events_workspace_id_attribution_id_event_ti_idx" ON "ctwa_conversion_events"("workspace_id", "attribution_id", "event_time", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ctwa_conversion_events_business_key" ON "ctwa_conversion_events"("workspace_id", "attribution_id", "event_name", "business_key");

-- AddForeignKey
ALTER TABLE "ctwa_attributions" ADD CONSTRAINT "ctwa_attributions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace_mirrors"("workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ctwa_attributions" ADD CONSTRAINT "ctwa_attributions_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ctwa_attributions" ADD CONSTRAINT "ctwa_attributions_workspace_id_channel_id_conversation_id_fkey" FOREIGN KEY ("workspace_id", "channel_id", "conversation_id") REFERENCES "conversations"("workspace_id", "channel_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ctwa_attributions" ADD CONSTRAINT "ctwa_attributions_workspace_id_conversation_id_message_id_fkey" FOREIGN KEY ("workspace_id", "conversation_id", "message_id") REFERENCES "messages"("workspace_id", "conversation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ctwa_conversion_events" ADD CONSTRAINT "ctwa_conversion_events_workspace_id_channel_id_conversatio_fkey" FOREIGN KEY ("workspace_id", "channel_id", "conversation_id", "message_id", "attribution_id") REFERENCES "ctwa_attributions"("workspace_id", "channel_id", "conversation_id", "message_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
