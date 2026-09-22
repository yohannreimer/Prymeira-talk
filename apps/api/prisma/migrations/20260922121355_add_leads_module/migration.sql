-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('google_maps', 'receita_federal');

-- CreateEnum
CREATE TYPE "LeadJobStatus" AS ENUM ('queued', 'running', 'completed', 'partial', 'failed');

-- CreateEnum
CREATE TYPE "LeadWhatsappStatus" AS ENUM ('unverified', 'checking', 'available', 'unavailable', 'failed');

-- CreateTable
CREATE TABLE "contact_tags" (
    "workspace_id" TEXT NOT NULL,
    "contact_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_tags_pkey" PRIMARY KEY ("workspace_id","contact_id","tag_id")
);

-- CreateTable
CREATE TABLE "lead_lists" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" "LeadSource" NOT NULL,
    "criteria" JSONB NOT NULL DEFAULT '{}',
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "processed_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "list_id" UUID NOT NULL,
    "source" "LeadSource" NOT NULL,
    "source_external_id" TEXT,
    "source_dedupe_key" TEXT NOT NULL,
    "company_name" TEXT,
    "trade_name" TEXT,
    "cnpj" TEXT,
    "cnae_primary" TEXT,
    "cnae_secondary" JSONB NOT NULL DEFAULT '[]',
    "category" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postal_code" TEXT,
    "phones" JSONB NOT NULL DEFAULT '[]',
    "normalized_phone" TEXT,
    "email" TEXT,
    "website" TEXT,
    "rating" DOUBLE PRECISION,
    "review_count" INTEGER,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "source_url" TEXT,
    "source_snapshot" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_jobs" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "list_id" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "status" "LeadJobStatus" NOT NULL DEFAULT 'queued',
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB NOT NULL DEFAULT '{}',
    "error_message" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_token" UUID,
    "lease_until" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_whatsapp_verifications" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "lead_id" UUID NOT NULL,
    "normalized_phone" TEXT NOT NULL,
    "channel_id" UUID,
    "status" "LeadWhatsappStatus" NOT NULL DEFAULT 'unverified',
    "error_message" TEXT,
    "checked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_whatsapp_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_contact_provenances" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "contact_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "list_id" UUID NOT NULL,
    "source" "LeadSource" NOT NULL,
    "source_url" TEXT,
    "whatsapp_status" "LeadWhatsappStatus" NOT NULL DEFAULT 'unverified',
    "suggested_message" TEXT,
    "quick_reply_snapshot" JSONB NOT NULL DEFAULT '{}',
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_contact_provenances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contact_tags_workspace_id_tag_id_idx" ON "contact_tags"("workspace_id", "tag_id");

-- CreateIndex
CREATE INDEX "lead_lists_workspace_id_source_created_at_idx" ON "lead_lists"("workspace_id", "source", "created_at");

-- CreateIndex
CREATE INDEX "lead_lists_workspace_id_updated_at_idx" ON "lead_lists"("workspace_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "lead_lists_workspace_id_id_key" ON "lead_lists"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "leads_workspace_id_list_id_created_at_idx" ON "leads"("workspace_id", "list_id", "created_at");

-- CreateIndex
CREATE INDEX "leads_workspace_id_cnpj_idx" ON "leads"("workspace_id", "cnpj");

-- CreateIndex
CREATE INDEX "leads_workspace_id_normalized_phone_idx" ON "leads"("workspace_id", "normalized_phone");

-- CreateIndex
CREATE INDEX "leads_workspace_id_source_external_id_idx" ON "leads"("workspace_id", "source_external_id");

-- CreateIndex
CREATE UNIQUE INDEX "leads_workspace_id_id_key" ON "leads"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "leads_workspace_id_list_id_source_dedupe_key_key" ON "leads"("workspace_id", "list_id", "source_dedupe_key");

-- CreateIndex
CREATE INDEX "lead_jobs_workspace_id_status_lease_until_idx" ON "lead_jobs"("workspace_id", "status", "lease_until");

-- CreateIndex
CREATE INDEX "lead_jobs_workspace_id_list_id_created_at_idx" ON "lead_jobs"("workspace_id", "list_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "lead_jobs_workspace_id_id_key" ON "lead_jobs"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_jobs_workspace_id_idempotency_key_key" ON "lead_jobs"("workspace_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "lead_whatsapp_verifications_workspace_id_lead_id_normalized_idx" ON "lead_whatsapp_verifications"("workspace_id", "lead_id", "normalized_phone", "checked_at");

-- CreateIndex
CREATE INDEX "lead_whatsapp_verifications_workspace_id_channel_id_status_idx" ON "lead_whatsapp_verifications"("workspace_id", "channel_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "lead_whatsapp_verifications_workspace_id_id_key" ON "lead_whatsapp_verifications"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "lead_contact_provenances_workspace_id_contact_id_imported_a_idx" ON "lead_contact_provenances"("workspace_id", "contact_id", "imported_at");

-- CreateIndex
CREATE INDEX "lead_contact_provenances_workspace_id_list_id_imported_at_idx" ON "lead_contact_provenances"("workspace_id", "list_id", "imported_at");

-- CreateIndex
CREATE UNIQUE INDEX "lead_contact_provenances_workspace_id_id_key" ON "lead_contact_provenances"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_contact_provenances_workspace_id_lead_id_key" ON "lead_contact_provenances"("workspace_id", "lead_id");

-- AddForeignKey
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_workspace_id_contact_id_fkey" FOREIGN KEY ("workspace_id", "contact_id") REFERENCES "contacts"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_workspace_id_tag_id_fkey" FOREIGN KEY ("workspace_id", "tag_id") REFERENCES "tags"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_workspace_id_list_id_fkey" FOREIGN KEY ("workspace_id", "list_id") REFERENCES "lead_lists"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_jobs" ADD CONSTRAINT "lead_jobs_workspace_id_list_id_fkey" FOREIGN KEY ("workspace_id", "list_id") REFERENCES "lead_lists"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_whatsapp_verifications" ADD CONSTRAINT "lead_whatsapp_verifications_workspace_id_lead_id_fkey" FOREIGN KEY ("workspace_id", "lead_id") REFERENCES "leads"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_whatsapp_verifications" ADD CONSTRAINT "lead_whatsapp_verifications_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_contact_provenances" ADD CONSTRAINT "lead_contact_provenances_workspace_id_contact_id_fkey" FOREIGN KEY ("workspace_id", "contact_id") REFERENCES "contacts"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_contact_provenances" ADD CONSTRAINT "lead_contact_provenances_workspace_id_lead_id_fkey" FOREIGN KEY ("workspace_id", "lead_id") REFERENCES "leads"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_contact_provenances" ADD CONSTRAINT "lead_contact_provenances_workspace_id_list_id_fkey" FOREIGN KEY ("workspace_id", "list_id") REFERENCES "lead_lists"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
