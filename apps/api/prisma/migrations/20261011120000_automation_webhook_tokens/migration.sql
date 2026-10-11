CREATE TABLE "automation_webhook_tokens" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "rule_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_webhook_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "automation_webhook_tokens_token_key"
  ON "automation_webhook_tokens"("token");

CREATE UNIQUE INDEX "automation_webhook_tokens_workspace_id_id_key"
  ON "automation_webhook_tokens"("workspace_id", "id");

CREATE UNIQUE INDEX "automation_webhook_tokens_workspace_id_rule_id_key"
  ON "automation_webhook_tokens"("workspace_id", "rule_id");

ALTER TABLE "automation_webhook_tokens"
  ADD CONSTRAINT "automation_webhook_tokens_workspace_id_rule_id_fkey"
  FOREIGN KEY ("workspace_id", "rule_id") REFERENCES "automation_rules"("workspace_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
