-- The weekly evaluation of each customer's new attendance agent (one customer may span several workspaces).
CREATE TABLE "ai_agent_evaluations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_key" TEXT NOT NULL,
    "agents" JSONB NOT NULL DEFAULT '[]',
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

CREATE UNIQUE INDEX "ai_agent_evaluations_client_key_period_start_key"
  ON "ai_agent_evaluations"("client_key", "period_start");

CREATE INDEX "ai_agent_evaluations_client_key_created_at_idx"
  ON "ai_agent_evaluations"("client_key", "created_at");
