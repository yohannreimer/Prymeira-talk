-- DropForeignKey
ALTER TABLE "outbound_bindings" DROP CONSTRAINT "outbound_bindings_workspace_id_channel_id_attempt_id_fkey";

-- DropForeignKey
ALTER TABLE "outbound_bindings" DROP CONSTRAINT "outbound_bindings_workspace_id_channel_id_result_id_fkey";

-- CreateTable
CREATE TABLE "outbound_recertifications" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" UUID NOT NULL,
    "intent_id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "ordinal" SERIAL NOT NULL,
    "authority_revision" INTEGER NOT NULL,
    "source" JSONB NOT NULL,
    "domain_fences" JSONB NOT NULL,
    "proof" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_recertifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbound_recertifications_workspace_id_channel_id_intent_id_idx" ON "outbound_recertifications"("workspace_id", "channel_id", "intent_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_recertifications_workspace_id_channel_id_id_key" ON "outbound_recertifications"("workspace_id", "channel_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_attempts_workspace_id_channel_id_intent_id_id_key" ON "outbound_attempts"("workspace_id", "channel_id", "intent_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_results_workspace_id_channel_id_attempt_id_id_key" ON "outbound_results"("workspace_id", "channel_id", "attempt_id", "id");

-- AddForeignKey
ALTER TABLE "outbound_bindings" ADD CONSTRAINT "outbound_bindings_workspace_id_channel_id_intent_id_attemp_fkey" FOREIGN KEY ("workspace_id", "channel_id", "intent_id", "attempt_id") REFERENCES "outbound_attempts"("workspace_id", "channel_id", "intent_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_bindings" ADD CONSTRAINT "outbound_bindings_workspace_id_channel_id_attempt_id_resul_fkey" FOREIGN KEY ("workspace_id", "channel_id", "attempt_id", "result_id") REFERENCES "outbound_results"("workspace_id", "channel_id", "attempt_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_recertifications" ADD CONSTRAINT "outbound_recertifications_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_recertifications" ADD CONSTRAINT "outbound_recertifications_workspace_id_channel_id_intent_i_fkey" FOREIGN KEY ("workspace_id", "channel_id", "intent_id") REFERENCES "outbound_intents"("workspace_id", "channel_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_recertifications" ADD CONSTRAINT "outbound_recertifications_workspace_id_channel_id_chat_id_fkey" FOREIGN KEY ("workspace_id", "channel_id", "chat_id") REFERENCES "canonical_chats"("workspace_id", "channel_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE TRIGGER outbound_recertifications_immutable BEFORE UPDATE OR DELETE ON outbound_recertifications FOR EACH ROW EXECUTE FUNCTION outbound_immutable_evidence();
CREATE FUNCTION outbound_immutable_correlation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(OLD)-'state') IS DISTINCT FROM (to_jsonb(NEW)-'state') THEN
    RAISE EXCEPTION 'Outbound correlation proof is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbound_correlations_immutable BEFORE UPDATE ON outbound_correlations FOR EACH ROW EXECUTE FUNCTION outbound_immutable_correlation();
