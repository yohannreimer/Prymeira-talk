CREATE TABLE "crm_lead_syncs" (
  "id" UUID NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "contact_id" UUID NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "title" TEXT NOT NULL,
  "remote_contact_id" TEXT,
  "remote_company_id" TEXT,
  "remote_lead_id" TEXT,
  "lease_token" UUID,
  "lease_until" TIMESTAMP(3),
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "crm_lead_syncs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "crm_lead_syncs_state_check" CHECK ("state" IN ('pending','creating_lead','lead_uncertain','note_pending','note_sending','note_uncertain','completed')),
  CONSTRAINT "crm_lead_syncs_lease_pair_check" CHECK (("lease_token" IS NULL) = ("lease_until" IS NULL)),
  CONSTRAINT "crm_lead_syncs_contact_fkey" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "contacts"("workspace_id","id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "crm_lead_syncs_workspace_id_id_key" ON "crm_lead_syncs"("workspace_id","id");
CREATE UNIQUE INDEX "crm_lead_syncs_workspace_id_contact_id_key" ON "crm_lead_syncs"("workspace_id","contact_id");
CREATE INDEX "crm_lead_syncs_state_lease_until_idx" ON "crm_lead_syncs"("state","lease_until");
