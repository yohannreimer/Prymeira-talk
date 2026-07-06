ALTER TABLE "tags" ADD COLUMN "use_guide" TEXT NOT NULL DEFAULT '';
ALTER TABLE "tags" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "ai_agent_allowed_tags" (
  "workspace_id" TEXT NOT NULL,
  "agent_id" UUID NOT NULL,
  "tag_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ai_agent_allowed_tags_pkey" PRIMARY KEY ("workspace_id", "agent_id", "tag_id")
);

CREATE INDEX "ai_agent_allowed_tags_workspace_id_tag_id_idx" ON "ai_agent_allowed_tags"("workspace_id", "tag_id");

ALTER TABLE "ai_agent_allowed_tags" ADD CONSTRAINT "ai_agent_allowed_tags_workspace_id_agent_id_fkey" FOREIGN KEY ("workspace_id", "agent_id") REFERENCES "ai_agents"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_agent_allowed_tags" ADD CONSTRAINT "ai_agent_allowed_tags_workspace_id_tag_id_fkey" FOREIGN KEY ("workspace_id", "tag_id") REFERENCES "tags"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
