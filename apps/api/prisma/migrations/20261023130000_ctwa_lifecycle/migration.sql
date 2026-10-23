ALTER TABLE "ctwa_conversion_events"
  ADD COLUMN "lifecycle_source" VARCHAR(32),
  ADD COLUMN "source_reference" VARCHAR(64),
  ADD COLUMN "lead_event_id" VARCHAR(80),
  ADD COLUMN "confirmed_by" VARCHAR(256),
  ADD COLUMN "value_cents" BIGINT;
-- Legacy rows remain untrusted. No data rewrite or conversion backfill.
ALTER TABLE "ctwa_conversion_events" ADD CONSTRAINT "ctwa_lifecycle_provenance_check" CHECK (
  (lifecycle_source IS NULL AND source_reference IS NULL AND lead_event_id IS NULL AND confirmed_by IS NULL AND value_cents IS NULL) OR
  (lifecycle_source IS NOT NULL AND source_reference IS NOT NULL AND source_reference ~ '^[a-f0-9]{64}$' AND lead_event_id IS NOT NULL AND lead_event_id ~ '^ctwa_[a-f0-9]{64}$' AND
    ((lifecycle_source = 'calendar_confirmed' AND event_name = 'QualifiedLead' AND business_key = 'once' AND confirmed_by IS NULL AND order_id IS NULL AND order_hash IS NULL AND value IS NULL AND value_cents IS NULL AND currency IS NULL) OR
     (lifecycle_source = 'owner_manual' AND event_name = 'Purchase' AND confirmed_by IS NOT NULL AND length(confirmed_by) > 0 AND order_id IS NOT NULL AND order_id ~ '^[A-Za-z0-9._:-]{1,128}$' AND order_hash IS NOT NULL AND order_hash = source_reference AND business_key = order_hash AND value_cents IS NOT NULL AND value_cents BETWEEN 1 AND 100000000000000 AND currency IS NOT NULL AND currency = 'BRL' AND value IS NOT NULL AND value = value_cents::numeric / 100)))
);
CREATE UNIQUE INDEX "ctwa_lifecycle_meeting_key" ON "ctwa_conversion_events" ("workspace_id", "conversation_id") WHERE lifecycle_source = 'calendar_confirmed';
CREATE UNIQUE INDEX "ctwa_lifecycle_sale_key" ON "ctwa_conversion_events" ("workspace_id", "source_reference") WHERE lifecycle_source = 'owner_manual';
CREATE INDEX "ctwa_lifecycle_recovery_idx" ON "ctwa_attributions" ("workspace_id", "source_mode", "captured_at", "conversation_id");
