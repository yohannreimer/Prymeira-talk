CREATE TYPE "DepartmentDistributionMode" AS ENUM ('manual', 'round_robin', 'least_open');
CREATE TYPE "DepartmentMemberRole" AS ENUM ('supervisor', 'agent');

ALTER TABLE "departments"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "distribution_mode" "DepartmentDistributionMode" NOT NULL DEFAULT 'manual',
  ADD COLUMN "business_hours" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "sla_first_response_minutes" INTEGER,
  ADD COLUMN "sla_resolution_minutes" INTEGER,
  ADD COLUMN "fallback_department_id" UUID,
  ADD COLUMN "last_assigned_member_id" UUID;

CREATE TABLE "department_members" (
  "workspace_id" TEXT NOT NULL,
  "department_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "role" "DepartmentMemberRole" NOT NULL DEFAULT 'agent',
  "permissions" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "department_members_pkey" PRIMARY KEY ("workspace_id", "department_id", "user_id")
);

CREATE TABLE "department_channel_rules" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" TEXT NOT NULL,
  "department_id" UUID NOT NULL,
  "channel_id" UUID NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "department_channel_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "departments_workspace_id_fallback_department_id_idx"
  ON "departments"("workspace_id", "fallback_department_id");

CREATE INDEX "department_members_workspace_id_user_id_idx"
  ON "department_members"("workspace_id", "user_id");

CREATE UNIQUE INDEX "department_channel_rules_workspace_id_id_key"
  ON "department_channel_rules"("workspace_id", "id");

CREATE UNIQUE INDEX "department_channel_rules_workspace_id_channel_id_key"
  ON "department_channel_rules"("workspace_id", "channel_id");

CREATE INDEX "department_channel_rules_workspace_id_department_id_idx"
  ON "department_channel_rules"("workspace_id", "department_id");

ALTER TABLE "departments"
  ADD CONSTRAINT "departments_workspace_id_fallback_department_id_fkey"
  FOREIGN KEY ("workspace_id", "fallback_department_id")
  REFERENCES "departments"("workspace_id", "id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

ALTER TABLE "department_members"
  ADD CONSTRAINT "department_members_workspace_id_department_id_fkey"
  FOREIGN KEY ("workspace_id", "department_id")
  REFERENCES "departments"("workspace_id", "id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "department_members"
  ADD CONSTRAINT "department_members_workspace_id_user_id_fkey"
  FOREIGN KEY ("workspace_id", "user_id")
  REFERENCES "user_profiles"("workspace_id", "id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "department_channel_rules"
  ADD CONSTRAINT "department_channel_rules_workspace_id_department_id_fkey"
  FOREIGN KEY ("workspace_id", "department_id")
  REFERENCES "departments"("workspace_id", "id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "department_channel_rules"
  ADD CONSTRAINT "department_channel_rules_workspace_id_channel_id_fkey"
  FOREIGN KEY ("workspace_id", "channel_id")
  REFERENCES "channels"("workspace_id", "id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
