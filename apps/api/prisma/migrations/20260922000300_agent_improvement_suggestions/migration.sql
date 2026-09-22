CREATE TABLE "ai_agent_improvements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" TEXT NOT NULL,
    "agent_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "source_message_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "rationale" TEXT,
    "source_customer_message" TEXT NOT NULL,
    "source_human_reply" TEXT NOT NULL,
    "detector" JSONB NOT NULL DEFAULT '{}',
    "clarification_answers" JSONB NOT NULL DEFAULT '{}',
    "clarification_normalization" JSONB NOT NULL DEFAULT '{}',
    "reviewed_at" TIMESTAMP(3),
    "accepted_knowledge_source_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_agent_improvements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_agent_improvements_workspace_id_id_key"
  ON "ai_agent_improvements"("workspace_id", "id");

CREATE UNIQUE INDEX "ai_agent_improvements_workspace_id_source_message_id_key"
  ON "ai_agent_improvements"("workspace_id", "source_message_id");

CREATE INDEX "ai_agent_improvements_workspace_id_agent_id_status_created_at_idx"
  ON "ai_agent_improvements"("workspace_id", "agent_id", "status", "created_at");

CREATE INDEX "ai_agent_improvements_workspace_id_conversation_id_created_at_idx"
  ON "ai_agent_improvements"("workspace_id", "conversation_id", "created_at");

ALTER TABLE "ai_agent_improvements"
  ADD CONSTRAINT "ai_agent_improvements_workspace_id_agent_id_fkey"
  FOREIGN KEY ("workspace_id", "agent_id") REFERENCES "ai_agents"("workspace_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_agent_improvements"
  ADD CONSTRAINT "ai_agent_improvements_workspace_id_conversation_id_fkey"
  FOREIGN KEY ("workspace_id", "conversation_id") REFERENCES "conversations"("workspace_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_agent_improvements"
  ADD CONSTRAINT "ai_agent_improvements_workspace_id_source_message_id_fkey"
  FOREIGN KEY ("workspace_id", "source_message_id") REFERENCES "messages"("workspace_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
