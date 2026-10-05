-- Base própria: companies imported from the workspace's own spreadsheets, grouped by region.
-- Additive only: a new lead source, a nullable region on leads and the regions of each workspace.
ALTER TYPE "LeadSource" ADD VALUE IF NOT EXISTS 'own_base';

ALTER TABLE "leads" ADD COLUMN "region" TEXT;
CREATE INDEX "leads_workspace_id_list_id_region_idx" ON "leads"("workspace_id", "list_id", "region");

CREATE TABLE "lead_regions" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cities" JSONB NOT NULL DEFAULT '[]',
    "seller" TEXT,
    "is_mine" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "lead_regions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "lead_regions_workspace_id_name_key" ON "lead_regions"("workspace_id", "name");
