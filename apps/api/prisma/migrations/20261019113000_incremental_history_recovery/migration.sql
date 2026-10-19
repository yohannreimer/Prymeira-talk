ALTER TABLE "channel_connections"
  ADD COLUMN "history_recovery_cursor" JSONB,
  ADD COLUMN "history_recovery_lease_token" UUID,
  ADD COLUMN "history_recovery_lease_until" TIMESTAMPTZ,
  ADD COLUMN "history_recovery_next_attempt_at" TIMESTAMPTZ,
  ADD COLUMN "history_recovery_failures" INTEGER NOT NULL DEFAULT 0;
