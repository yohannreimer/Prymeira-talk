-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "prospecting_agent_id" UUID,
ADD COLUMN     "prospecting_context" TEXT;

-- AlterTable
ALTER TABLE "ai_agents" ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'attendance';

-- AlterTable
ALTER TABLE "ai_agent_sessions" ADD COLUMN     "first_response_at" TIMESTAMP(3),
ADD COLUMN     "first_response_message_id" UUID,
ADD COLUMN     "prospecting_generation" UUID,
ADD COLUMN     "source_campaign_id" UUID,
ADD COLUMN     "source_recipient_id" UUID;

-- CreateTable
CREATE TABLE "campaign_prospecting_reservations" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "generation" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'sending',
    "dispatch_started_at" TIMESTAMP(3) NOT NULL,
    "confirmed_at" TIMESTAMP(3),
    "pending_inbound_message_id" UUID,
    "pending_inbound_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_prospecting_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaign_prospecting_reservations_workspace_id_campaign_id_idx" ON "campaign_prospecting_reservations"("workspace_id", "campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_prospecting_reservations_workspace_id_channel_id_c_key" ON "campaign_prospecting_reservations"("workspace_id", "channel_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_prospecting_reservations_workspace_id_conversation_key" ON "campaign_prospecting_reservations"("workspace_id", "conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_prospecting_reservations_workspace_id_recipient_id_key" ON "campaign_prospecting_reservations"("workspace_id", "recipient_id");

-- AddForeignKey
ALTER TABLE "campaign_prospecting_reservations" ADD CONSTRAINT "campaign_prospecting_reservations_workspace_id_conversatio_fkey" FOREIGN KEY ("workspace_id", "conversation_id") REFERENCES "conversations"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_prospecting_reservations" ADD CONSTRAINT "campaign_prospecting_reservations_workspace_id_campaign_id_fkey" FOREIGN KEY ("workspace_id", "campaign_id") REFERENCES "campaigns"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

