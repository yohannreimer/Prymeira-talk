CREATE TABLE "ai_agent_evaluations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" TEXT NOT NULL,
    "agent_id" UUID NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "summary" JSONB NOT NULL DEFAULT '{}',
    "cases" JSONB NOT NULL DEFAULT '[]',
    "proposals" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_agent_evaluations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_agent_evaluations_workspace_id_id_key"
  ON "ai_agent_evaluations"("workspace_id", "id");

CREATE UNIQUE INDEX "ai_agent_evaluations_workspace_id_agent_id_period_start_key"
  ON "ai_agent_evaluations"("workspace_id", "agent_id", "period_start");

CREATE INDEX "ai_agent_evaluations_workspace_id_agent_id_created_at_idx"
  ON "ai_agent_evaluations"("workspace_id", "agent_id", "created_at");

ALTER TABLE "ai_agent_evaluations"
  ADD CONSTRAINT "ai_agent_evaluations_workspace_id_agent_id_fkey"
  FOREIGN KEY ("workspace_id", "agent_id") REFERENCES "ai_agents"("workspace_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
