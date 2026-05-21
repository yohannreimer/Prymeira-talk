-- CreateEnum
CREATE TYPE "IntegrationMode" AS ENUM ('simulated', 'real');

-- CreateEnum
CREATE TYPE "AutomationStatus" AS ENUM ('enabled', 'disabled');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('draft', 'scheduled', 'sending', 'completed', 'failed');

-- CreateTable
CREATE TABLE "contact_boards" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_boards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_board_stages" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "board_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_board_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_board_memberships" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "contact_id" UUID NOT NULL,
    "board_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_board_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_notes" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "contact_id" UUID NOT NULL,
    "conversation_id" UUID,
    "body" TEXT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_rules" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "AutomationStatus" NOT NULL DEFAULT 'disabled',
    "trigger" TEXT NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "rule_id" UUID NOT NULL,
    "event_key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "input" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'draft',
    "audience" JSONB NOT NULL DEFAULT '{}',
    "message_body" TEXT NOT NULL,
    "scheduled_at" TIMESTAMP(3),
    "mode" "IntegrationMode" NOT NULL DEFAULT 'simulated',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_recipients" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "campaign_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_action_logs" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "conversation_id" UUID,
    "contact_id" UUID,
    "user_id" UUID,
    "action_type" TEXT NOT NULL,
    "mode" "IntegrationMode" NOT NULL DEFAULT 'simulated',
    "input" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_action_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_sync_actions" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "contact_id" UUID,
    "action_type" TEXT NOT NULL,
    "mode" "IntegrationMode" NOT NULL DEFAULT 'simulated',
    "status" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_sync_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_configs" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "mode" "IntegrationMode" NOT NULL DEFAULT 'simulated',
    "status" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contact_boards_workspace_id_id_key" ON "contact_boards"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_boards_workspace_id_name_key" ON "contact_boards"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "contact_board_stages_workspace_id_board_id_sort_order_idx" ON "contact_board_stages"("workspace_id", "board_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "contact_board_stages_workspace_id_id_key" ON "contact_board_stages"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_board_stages_workspace_id_board_id_name_key" ON "contact_board_stages"("workspace_id", "board_id", "name");

-- CreateIndex
CREATE INDEX "contact_board_memberships_workspace_id_contact_id_is_primar_idx" ON "contact_board_memberships"("workspace_id", "contact_id", "is_primary");

-- CreateIndex
CREATE INDEX "contact_board_memberships_workspace_id_board_id_stage_id_idx" ON "contact_board_memberships"("workspace_id", "board_id", "stage_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_board_memberships_workspace_id_id_key" ON "contact_board_memberships"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_board_memberships_workspace_id_contact_id_board_id_key" ON "contact_board_memberships"("workspace_id", "contact_id", "board_id");

-- CreateIndex
CREATE INDEX "contact_notes_workspace_id_contact_id_created_at_idx" ON "contact_notes"("workspace_id", "contact_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "contact_notes_workspace_id_id_key" ON "contact_notes"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "automation_rules_workspace_id_status_idx" ON "automation_rules"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "automation_rules_workspace_id_id_key" ON "automation_rules"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "automation_runs_workspace_id_created_at_idx" ON "automation_runs"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "automation_runs_workspace_id_id_key" ON "automation_runs"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "automation_runs_workspace_id_rule_id_event_key_key" ON "automation_runs"("workspace_id", "rule_id", "event_key");

-- CreateIndex
CREATE INDEX "campaigns_workspace_id_status_idx" ON "campaigns"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_workspace_id_id_key" ON "campaigns"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "campaign_recipients_workspace_id_campaign_id_status_idx" ON "campaign_recipients"("workspace_id", "campaign_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipients_workspace_id_id_key" ON "campaign_recipients"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipients_workspace_id_campaign_id_contact_id_key" ON "campaign_recipients"("workspace_id", "campaign_id", "contact_id");

-- CreateIndex
CREATE INDEX "ai_action_logs_workspace_id_created_at_idx" ON "ai_action_logs"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_action_logs_workspace_id_id_key" ON "ai_action_logs"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "crm_sync_actions_workspace_id_contact_id_idx" ON "crm_sync_actions"("workspace_id", "contact_id");

-- CreateIndex
CREATE INDEX "crm_sync_actions_workspace_id_created_at_idx" ON "crm_sync_actions"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "crm_sync_actions_workspace_id_id_key" ON "crm_sync_actions"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_configs_workspace_id_id_key" ON "integration_configs"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_configs_workspace_id_provider_key" ON "integration_configs"("workspace_id", "provider");

-- CreateIndex
CREATE INDEX "audit_logs_workspace_id_created_at_idx" ON "audit_logs"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_workspace_id_id_key" ON "audit_logs"("workspace_id", "id");

-- AddForeignKey
ALTER TABLE "contact_board_stages" ADD CONSTRAINT "contact_board_stages_workspace_id_board_id_fkey" FOREIGN KEY ("workspace_id", "board_id") REFERENCES "contact_boards"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_board_memberships" ADD CONSTRAINT "contact_board_memberships_workspace_id_contact_id_fkey" FOREIGN KEY ("workspace_id", "contact_id") REFERENCES "contacts"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_board_memberships" ADD CONSTRAINT "contact_board_memberships_workspace_id_board_id_fkey" FOREIGN KEY ("workspace_id", "board_id") REFERENCES "contact_boards"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_board_memberships" ADD CONSTRAINT "contact_board_memberships_workspace_id_stage_id_fkey" FOREIGN KEY ("workspace_id", "stage_id") REFERENCES "contact_board_stages"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_workspace_id_contact_id_fkey" FOREIGN KEY ("workspace_id", "contact_id") REFERENCES "contacts"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_workspace_id_rule_id_fkey" FOREIGN KEY ("workspace_id", "rule_id") REFERENCES "automation_rules"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_workspace_id_campaign_id_fkey" FOREIGN KEY ("workspace_id", "campaign_id") REFERENCES "campaigns"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_workspace_id_contact_id_fkey" FOREIGN KEY ("workspace_id", "contact_id") REFERENCES "contacts"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
