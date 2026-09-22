ALTER TABLE "lead_artifacts" DROP CONSTRAINT "lead_artifacts_workspace_id_job_id_fkey";

CREATE UNIQUE INDEX "lead_jobs_workspace_id_id_list_id_key"
    ON "lead_jobs"("workspace_id", "id", "list_id");
CREATE INDEX "lead_jobs_status_created_at_id_idx"
    ON "lead_jobs"("status", "created_at", "id");
CREATE INDEX "lead_jobs_status_lease_until_idx"
    ON "lead_jobs"("status", "lease_until");

ALTER TABLE "lead_artifacts"
    ADD CONSTRAINT "lead_artifacts_workspace_id_job_id_list_id_fkey"
    FOREIGN KEY ("workspace_id", "job_id", "list_id")
    REFERENCES "lead_jobs"("workspace_id", "id", "list_id")
    ON DELETE CASCADE ON UPDATE CASCADE;
