-- CreateEnum
CREATE TYPE "ConversationFollowupKind" AS ENUM ('qualification', 'human_commercial');

-- CreateEnum
CREATE TYPE "ConversationFollowupStatus" AS ENUM ('scheduled', 'processing', 'review', 'sent', 'cancelled', 'skipped', 'expired', 'failed');

-- CreateTable
CREATE TABLE "conversation_followups" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "conversation_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "session_id" UUID,
    "kind" "ConversationFollowupKind" NOT NULL,
    "status" "ConversationFollowupStatus" NOT NULL DEFAULT 'scheduled',
    "active_key" TEXT,
    "step_index" INTEGER NOT NULL DEFAULT 0,
    "anchor_message_id" UUID NOT NULL,
    "anchor_message_at" TIMESTAMP(3) NOT NULL,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "locked_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "decision" JSONB NOT NULL DEFAULT '{}',
    "draft_body" TEXT,
    "final_body" TEXT,
    "reason" TEXT,
    "sent_by_user_id" UUID,
    "sent_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_followups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversation_followups_workspace_id_id_key" ON "conversation_followups"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_followups_workspace_id_conversation_id_active__key" ON "conversation_followups"("workspace_id", "conversation_id", "active_key");

-- CreateIndex
CREATE INDEX "conversation_followups_status_scheduled_at_idx" ON "conversation_followups"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "conversation_followups_workspace_id_conversation_id_created_idx" ON "conversation_followups"("workspace_id", "conversation_id", "created_at");

-- AddForeignKey
ALTER TABLE "conversation_followups" ADD CONSTRAINT "conversation_followups_workspace_id_conversation_id_fkey" FOREIGN KEY ("workspace_id", "conversation_id") REFERENCES "conversations"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_followups" ADD CONSTRAINT "conversation_followups_workspace_id_agent_id_fkey" FOREIGN KEY ("workspace_id", "agent_id") REFERENCES "ai_agents"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_followups" ADD CONSTRAINT "conversation_followups_workspace_id_session_id_fkey" FOREIGN KEY ("workspace_id", "session_id") REFERENCES "ai_agent_sessions"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_followups" ADD CONSTRAINT "conversation_followups_workspace_id_anchor_message_id_fkey" FOREIGN KEY ("workspace_id", "anchor_message_id") REFERENCES "messages"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_followups" ADD CONSTRAINT "conversation_followups_workspace_id_sent_by_user_id_fkey" FOREIGN KEY ("workspace_id", "sent_by_user_id") REFERENCES "user_profiles"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_followups" ADD CONSTRAINT "conversation_followups_workspace_id_cancelled_by_user_id_fkey" FOREIGN KEY ("workspace_id", "cancelled_by_user_id") REFERENCES "user_profiles"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
