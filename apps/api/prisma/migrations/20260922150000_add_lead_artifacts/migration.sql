-- Error and input CSV artifacts are private operational records. Their compound
-- foreign keys preserve the same workspace boundary as lists and jobs.
CREATE TABLE "lead_artifacts" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "list_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_artifacts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "lead_artifacts_workspace_id_id_key"
    ON "lead_artifacts"("workspace_id", "id");
CREATE UNIQUE INDEX "lead_artifacts_workspace_id_job_id_kind_key"
    ON "lead_artifacts"("workspace_id", "job_id", "kind");
CREATE INDEX "lead_artifacts_workspace_id_list_id_created_at_idx"
    ON "lead_artifacts"("workspace_id", "list_id", "created_at");

ALTER TABLE "lead_artifacts"
    ADD CONSTRAINT "lead_artifacts_workspace_id_list_id_fkey"
    FOREIGN KEY ("workspace_id", "list_id")
    REFERENCES "lead_lists"("workspace_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lead_artifacts"
    ADD CONSTRAINT "lead_artifacts_workspace_id_job_id_fkey"
    FOREIGN KEY ("workspace_id", "job_id")
    REFERENCES "lead_jobs"("workspace_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;
