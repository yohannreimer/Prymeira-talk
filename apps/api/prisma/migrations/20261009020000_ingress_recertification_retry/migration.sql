CREATE TABLE "ingress_recertification_retries" (
  "workspace_id" TEXT NOT NULL,
  "channel_id" UUID NOT NULL,
  "receipt_id" UUID NOT NULL,
  "event_index" INTEGER NOT NULL,
  "next_attempt_at" TIMESTAMPTZ NOT NULL,
  "lease_token" UUID,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_outcome" TEXT,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ingress_recertification_retries_pkey" PRIMARY KEY ("receipt_id", "event_index"),
  CONSTRAINT "ingress_recertification_retry_progress_fkey" FOREIGN KEY ("workspace_id", "channel_id", "receipt_id", "event_index") REFERENCES "ingress_event_progress"("workspace_id", "channel_id", "receipt_id", "event_index") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ingress_recertification_retries_next_attempt_at_idx" ON "ingress_recertification_retries"("next_attempt_at");
CREATE INDEX "ingress_progress_recovery_idx" ON "ingress_event_progress"("state", "reason", "committed_at") WHERE "state" IN ('held', 'pending_recertification');
CREATE UNIQUE INDEX "ingress_recertification_retry_scope_key" ON "ingress_recertification_retries"("workspace_id", "channel_id", "receipt_id", "event_index");
