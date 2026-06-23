CREATE TYPE "AiAgentStatus" AS ENUM ('active', 'inactive');

CREATE TYPE "AiProviderMode" AS ENUM ('prymeira_managed', 'workspace_key');

CREATE TYPE "AiKnowledgeSourceType" AS ENUM ('faq', 'text', 'file');

CREATE TYPE "AiKnowledgeSourceStatus" AS ENUM ('ready', 'processing', 'failed');

CREATE TYPE "AiAgentSessionStatus" AS ENUM ('active', 'paused_by_human', 'handoff_requested', 'closed');

CREATE TYPE "AiAgentRunStatus" AS ENUM ('completed', 'handoff_requested', 'failed', 'skipped');

CREATE TYPE "AiAgentRunTrigger" AS ENUM ('automation', 'manual_test');

CREATE TYPE "AiControlStatus" AS ENUM ('agent_allowed', 'human_controlled');

ALTER TABLE "conversations"
  ADD COLUMN "ai_control_status" "AiControlStatus" NOT NULL DEFAULT 'agent_allowed',
  ADD COLUMN "ai_control_updated_at" TIMESTAMP(3),
  ADD COLUMN "ai_control_updated_by_id" UUID,
  ADD COLUMN "active_agent_session_id" UUID;

CREATE TABLE "ai_agents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "AiAgentStatus" NOT NULL DEFAULT 'inactive',
    "provider_mode" "AiProviderMode" NOT NULL DEFAULT 'prymeira_managed',
    "provider" TEXT NOT NULL DEFAULT 'simulated',
    "model" TEXT NOT NULL DEFAULT 'prymeira-simulated',
    "system_prompt" TEXT NOT NULL,
    "behavior_config" JSONB NOT NULL DEFAULT '{}',
    "handoff_config" JSONB NOT NULL DEFAULT '{}',
    "limits_config" JSONB NOT NULL DEFAULT '{}',
    "allowed_actions" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_agents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ai_knowledge_sources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" TEXT NOT NULL,
    "agent_id" UUID NOT NULL,
    "type" "AiKnowledgeSourceType" NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT,
    "file_url" TEXT,
    "file_name" TEXT,
    "mime_type" TEXT,
    "status" "AiKnowledgeSourceStatus" NOT NULL DEFAULT 'ready',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_knowledge_sources_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ai_agent_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" TEXT NOT NULL,
    "agent_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "status" "AiAgentSessionStatus" NOT NULL DEFAULT 'active',
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "last_run_at" TIMESTAMP(3),
    "handoff_reason" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_agent_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ai_agent_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" TEXT NOT NULL,
    "agent_id" UUID NOT NULL,
    "session_id" UUID,
    "conversation_id" UUID,
    "trigger" "AiAgentRunTrigger" NOT NULL,
    "input" JSONB NOT NULL DEFAULT '{}',
    "context_summary" JSONB NOT NULL DEFAULT '{}',
    "knowledge_matches" JSONB NOT NULL DEFAULT '[]',
    "output" JSONB NOT NULL DEFAULT '{}',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "status" "AiAgentRunStatus" NOT NULL,
    "model" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "cost_estimate" JSONB NOT NULL DEFAULT '{}',
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agent_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_agents_workspace_id_id_key" ON "ai_agents"("workspace_id", "id");
CREATE INDEX "ai_agents_workspace_id_status_idx" ON "ai_agents"("workspace_id", "status");

CREATE UNIQUE INDEX "ai_knowledge_sources_workspace_id_id_key" ON "ai_knowledge_sources"("workspace_id", "id");
CREATE INDEX "ai_knowledge_sources_workspace_id_agent_id_idx" ON "ai_knowledge_sources"("workspace_id", "agent_id");

CREATE UNIQUE INDEX "ai_agent_sessions_workspace_id_id_key" ON "ai_agent_sessions"("workspace_id", "id");
CREATE UNIQUE INDEX "ai_agent_sessions_workspace_id_agent_id_conversation_id_key" ON "ai_agent_sessions"("workspace_id", "agent_id", "conversation_id");
CREATE INDEX "ai_agent_sessions_workspace_id_conversation_id_status_idx" ON "ai_agent_sessions"("workspace_id", "conversation_id", "status");

CREATE UNIQUE INDEX "ai_agent_runs_workspace_id_id_key" ON "ai_agent_runs"("workspace_id", "id");
CREATE INDEX "ai_agent_runs_workspace_id_agent_id_created_at_idx" ON "ai_agent_runs"("workspace_id", "agent_id", "created_at");
CREATE INDEX "ai_agent_runs_workspace_id_conversation_id_created_at_idx" ON "ai_agent_runs"("workspace_id", "conversation_id", "created_at");
CREATE INDEX "ai_agent_runs_workspace_id_status_idx" ON "ai_agent_runs"("workspace_id", "status");

ALTER TABLE "ai_knowledge_sources" ADD CONSTRAINT "ai_knowledge_sources_workspace_id_agent_id_fkey" FOREIGN KEY ("workspace_id", "agent_id") REFERENCES "ai_agents"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_agent_sessions" ADD CONSTRAINT "ai_agent_sessions_workspace_id_agent_id_fkey" FOREIGN KEY ("workspace_id", "agent_id") REFERENCES "ai_agents"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_agent_sessions" ADD CONSTRAINT "ai_agent_sessions_workspace_id_conversation_id_fkey" FOREIGN KEY ("workspace_id", "conversation_id") REFERENCES "conversations"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_agent_runs" ADD CONSTRAINT "ai_agent_runs_workspace_id_agent_id_fkey" FOREIGN KEY ("workspace_id", "agent_id") REFERENCES "ai_agents"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_agent_runs" ADD CONSTRAINT "ai_agent_runs_workspace_id_session_id_fkey" FOREIGN KEY ("workspace_id", "session_id") REFERENCES "ai_agent_sessions"("workspace_id", "id") ON DELETE SET NULL ("session_id") ON UPDATE CASCADE;

ALTER TABLE "ai_agent_runs" ADD CONSTRAINT "ai_agent_runs_workspace_id_conversation_id_fkey" FOREIGN KEY ("workspace_id", "conversation_id") REFERENCES "conversations"("workspace_id", "id") ON DELETE SET NULL ("conversation_id") ON UPDATE CASCADE;
