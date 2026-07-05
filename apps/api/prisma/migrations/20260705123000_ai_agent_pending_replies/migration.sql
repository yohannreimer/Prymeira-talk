CREATE TABLE "ai_agent_pending_replies" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" TEXT NOT NULL,
  "conversation_id" UUID NOT NULL,
  "agent_id" UUID NOT NULL,
  "session_id" UUID,
  "last_message_id" UUID NOT NULL,
  "instruction" TEXT,
  "scheduled_at" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "locked_at" TIMESTAMP(3),
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ai_agent_pending_replies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_agent_pending_replies_workspace_id_id_key" ON "ai_agent_pending_replies"("workspace_id", "id");
CREATE UNIQUE INDEX "ai_agent_pending_replies_workspace_id_conversation_id_key" ON "ai_agent_pending_replies"("workspace_id", "conversation_id");
CREATE INDEX "ai_agent_pending_replies_status_scheduled_at_idx" ON "ai_agent_pending_replies"("status", "scheduled_at");
CREATE INDEX "ai_agent_pending_replies_workspace_id_agent_id_idx" ON "ai_agent_pending_replies"("workspace_id", "agent_id");

ALTER TABLE "ai_agent_pending_replies" ADD CONSTRAINT "ai_agent_pending_replies_workspace_id_agent_id_fkey" FOREIGN KEY ("workspace_id", "agent_id") REFERENCES "ai_agents"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_agent_pending_replies" ADD CONSTRAINT "ai_agent_pending_replies_workspace_id_conversation_id_fkey" FOREIGN KEY ("workspace_id", "conversation_id") REFERENCES "conversations"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_agent_pending_replies" ADD CONSTRAINT "ai_agent_pending_replies_workspace_id_session_id_fkey" FOREIGN KEY ("workspace_id", "session_id") REFERENCES "ai_agent_sessions"("workspace_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;
