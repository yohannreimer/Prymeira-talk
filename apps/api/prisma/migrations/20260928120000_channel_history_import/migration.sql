ALTER TABLE "channels"
    ADD COLUMN "history_import_status" TEXT,
    ADD COLUMN "history_import_next_at" TIMESTAMP(3),
    ADD COLUMN "history_import_lease_token" UUID,
    ADD COLUMN "history_import_lease_until" TIMESTAMP(3),
    ADD COLUMN "history_import_attempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "history_import_completed_at" TIMESTAMP(3);

CREATE INDEX "channels_history_import_status_history_import_next_at_idx"
    ON "channels"("history_import_status", "history_import_next_at");
