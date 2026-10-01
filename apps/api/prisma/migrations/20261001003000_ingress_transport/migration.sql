-- CreateTable
CREATE TABLE "ingress_receipts" (
    "id" UUID NOT NULL,
    "ordinal" BIGSERIAL NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" UUID NOT NULL,
    "stage_version" INTEGER NOT NULL,
    "transport_namespace" TEXT NOT NULL,
    "source" JSONB NOT NULL,
    "authentication" TEXT NOT NULL,
    "authenticated_digest" TEXT NOT NULL,
    "raw_ref" TEXT NOT NULL,
    "raw_digest" TEXT NOT NULL,
    "event_ref" TEXT NOT NULL,
    "event_digest" TEXT NOT NULL,
    "event_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingress_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingress_deliveries" (
    "receipt_id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" UUID NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'staged',
    "confirmed_at" TIMESTAMP(3),
    "consumed_at" TIMESTAMP(3),
    "lease_token" UUID,
    "lease_until" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "recoveries" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "ingress_deliveries_pkey" PRIMARY KEY ("receipt_id")
);

-- CreateTable
CREATE TABLE "ingress_applications" (
    "receipt_id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" UUID NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending_application',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMP(3),

    CONSTRAINT "ingress_applications_pkey" PRIMARY KEY ("receipt_id")
);

-- CreateTable
CREATE TABLE "ingress_frontiers" (
    "id" BIGSERIAL NOT NULL,
    "receipt_id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" UUID NOT NULL,
    "event_index" INTEGER NOT NULL,
    "chat_address" TEXT,
    "exact_key" JSONB,
    "kind" TEXT NOT NULL,

    CONSTRAINT "ingress_frontiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingress_publish_attempts" (
    "id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" UUID NOT NULL,
    "destination" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'pending',
    "error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMP(3),

    CONSTRAINT "ingress_publish_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingress_quarantines" (
    "id" UUID NOT NULL,
    "raw_ref" TEXT NOT NULL,
    "raw_digest" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingress_quarantines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ingress_receipts_ordinal_key" ON "ingress_receipts"("ordinal");

-- CreateIndex
CREATE INDEX "ingress_receipts_workspace_id_channel_id_ordinal_idx" ON "ingress_receipts"("workspace_id", "channel_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "ingress_receipts_workspace_id_channel_id_id_key" ON "ingress_receipts"("workspace_id", "channel_id", "id");

-- CreateIndex
CREATE INDEX "ingress_deliveries_state_next_attempt_at_lease_until_idx" ON "ingress_deliveries"("state", "next_attempt_at", "lease_until");

-- CreateIndex
CREATE UNIQUE INDEX "ingress_deliveries_workspace_id_channel_id_receipt_id_key" ON "ingress_deliveries"("workspace_id", "channel_id", "receipt_id");

-- CreateIndex
CREATE INDEX "ingress_applications_workspace_id_channel_id_state_created__idx" ON "ingress_applications"("workspace_id", "channel_id", "state", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ingress_applications_workspace_id_channel_id_receipt_id_key" ON "ingress_applications"("workspace_id", "channel_id", "receipt_id");

-- CreateIndex
CREATE INDEX "ingress_frontiers_workspace_id_channel_id_chat_address_id_idx" ON "ingress_frontiers"("workspace_id", "channel_id", "chat_address", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ingress_frontiers_receipt_id_event_index_key" ON "ingress_frontiers"("receipt_id", "event_index");

-- CreateIndex
CREATE INDEX "ingress_publish_attempts_receipt_id_created_at_idx" ON "ingress_publish_attempts"("receipt_id", "created_at");

-- AddForeignKey
ALTER TABLE "ingress_receipts" ADD CONSTRAINT "ingress_receipts_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingress_deliveries" ADD CONSTRAINT "ingress_deliveries_workspace_id_channel_id_receipt_id_fkey" FOREIGN KEY ("workspace_id", "channel_id", "receipt_id") REFERENCES "ingress_receipts"("workspace_id", "channel_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingress_applications" ADD CONSTRAINT "ingress_applications_workspace_id_channel_id_receipt_id_fkey" FOREIGN KEY ("workspace_id", "channel_id", "receipt_id") REFERENCES "ingress_receipts"("workspace_id", "channel_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingress_frontiers" ADD CONSTRAINT "ingress_frontiers_workspace_id_channel_id_receipt_id_fkey" FOREIGN KEY ("workspace_id", "channel_id", "receipt_id") REFERENCES "ingress_receipts"("workspace_id", "channel_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingress_publish_attempts" ADD CONSTRAINT "ingress_publish_attempts_workspace_id_channel_id_receipt_i_fkey" FOREIGN KEY ("workspace_id", "channel_id", "receipt_id") REFERENCES "ingress_receipts"("workspace_id", "channel_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Accepted facts cannot be rewritten by retries, lifecycle changes or recovery.
CREATE FUNCTION ingress_immutable_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable ingress fact'; END;
$$;
CREATE TRIGGER ingress_receipt_immutable BEFORE UPDATE ON ingress_receipts FOR EACH ROW EXECUTE FUNCTION ingress_immutable_fact();
CREATE TRIGGER ingress_frontier_immutable BEFORE UPDATE ON ingress_frontiers FOR EACH ROW EXECUTE FUNCTION ingress_immutable_fact();
ALTER TABLE ingress_receipts ADD CONSTRAINT ingress_stage_version CHECK (stage_version = 1),
  ADD CONSTRAINT ingress_event_count CHECK (event_count > 0),
  ADD CONSTRAINT ingress_source_scope CHECK (source->>'workspaceId' = workspace_id AND source->>'channelId' = channel_id::text);
ALTER TABLE ingress_deliveries ADD CONSTRAINT ingress_delivery_state CHECK (state IN ('staged','routed','pending_application','dead_letter')),
  ADD CONSTRAINT ingress_delivery_failures CHECK (failures >= 0 AND recoveries >= 0),
  ADD CONSTRAINT ingress_delivery_lease CHECK ((lease_token IS NULL) = (lease_until IS NULL));
ALTER TABLE ingress_applications ADD CONSTRAINT ingress_application_state CHECK (state IN ('pending_application','applied','held')),
  ADD CONSTRAINT ingress_application_completion CHECK ((state = 'applied') = (applied_at IS NOT NULL));
ALTER TABLE ingress_publish_attempts ADD CONSTRAINT ingress_publish_outcome CHECK (outcome IN ('pending','confirmed','failed','uncertain')),
  ADD CONSTRAINT ingress_publish_destination CHECK (destination IN ('incoming','retry','dead'));
