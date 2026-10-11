-- CreateTable
CREATE TABLE "outbound_intents" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "ordinal" SERIAL NOT NULL,
    "origin_kind" VARCHAR(40) NOT NULL,
    "origin_id" VARCHAR(256) NOT NULL,
    "action_ordinal" INTEGER NOT NULL,
    "request_key" VARCHAR(256) NOT NULL,
    "request" JSONB NOT NULL,
    "domain_fences" JSONB NOT NULL,
    "authority_revision" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'prepared',
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_attempts" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" UUID NOT NULL,
    "intent_id" UUID NOT NULL,
    "token" UUID NOT NULL,
    "source" JSONB NOT NULL,
    "domain_fences" JSONB NOT NULL,
    "chat_id" UUID NOT NULL,
    "authority_revision" INTEGER NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'dispatching',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_results" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "result_key" VARCHAR(256) NOT NULL,
    "outcome" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_bindings" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" UUID NOT NULL,
    "intent_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "result_id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "alias_id" UUID NOT NULL,
    "source" JSONB NOT NULL,
    "key" JSONB NOT NULL,
    "proof" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_correlations" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "tuple_hash" VARCHAR(64) NOT NULL,
    "full_tuple" JSONB NOT NULL,
    "proof" JSONB NOT NULL,
    "state" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_correlations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outbound_intents_message_id_key" ON "outbound_intents"("message_id");

-- CreateIndex
CREATE INDEX "outbound_intents_workspace_id_channel_id_chat_id_state_ordi_idx" ON "outbound_intents"("workspace_id", "channel_id", "chat_id", "state", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_intents_workspace_id_channel_id_id_key" ON "outbound_intents"("workspace_id", "channel_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_intents_workspace_id_channel_id_origin_kind_origin_key" ON "outbound_intents"("workspace_id", "channel_id", "origin_kind", "origin_id", "action_ordinal", "request_key");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_attempts_token_key" ON "outbound_attempts"("token");

-- CreateIndex
CREATE INDEX "outbound_attempts_workspace_id_channel_id_intent_id_created_idx" ON "outbound_attempts"("workspace_id", "channel_id", "intent_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_attempts_workspace_id_channel_id_id_key" ON "outbound_attempts"("workspace_id", "channel_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_results_workspace_id_channel_id_id_key" ON "outbound_results"("workspace_id", "channel_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_results_workspace_id_channel_id_attempt_id_result__key" ON "outbound_results"("workspace_id", "channel_id", "attempt_id", "result_key");

-- CreateIndex
CREATE INDEX "outbound_bindings_workspace_id_channel_id_intent_id_idx" ON "outbound_bindings"("workspace_id", "channel_id", "intent_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_bindings_workspace_id_channel_id_id_key" ON "outbound_bindings"("workspace_id", "channel_id", "id");

-- CreateIndex
CREATE INDEX "outbound_correlations_workspace_id_channel_id_tuple_hash_idx" ON "outbound_correlations"("workspace_id", "channel_id", "tuple_hash");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_correlations_workspace_id_channel_id_id_key" ON "outbound_correlations"("workspace_id", "channel_id", "id");

-- AddForeignKey
ALTER TABLE "outbound_intents" ADD CONSTRAINT "outbound_intents_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_intents" ADD CONSTRAINT "outbound_intents_workspace_id_channel_id_conversation_id_fkey" FOREIGN KEY ("workspace_id", "channel_id", "conversation_id") REFERENCES "conversations"("workspace_id", "channel_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_intents" ADD CONSTRAINT "outbound_intents_workspace_id_conversation_id_message_id_fkey" FOREIGN KEY ("workspace_id", "conversation_id", "message_id") REFERENCES "messages"("workspace_id", "conversation_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_intents" ADD CONSTRAINT "outbound_intents_workspace_id_channel_id_chat_id_fkey" FOREIGN KEY ("workspace_id", "channel_id", "chat_id") REFERENCES "canonical_chats"("workspace_id", "channel_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_attempts" ADD CONSTRAINT "outbound_attempts_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_attempts" ADD CONSTRAINT "outbound_attempts_workspace_id_channel_id_intent_id_fkey" FOREIGN KEY ("workspace_id", "channel_id", "intent_id") REFERENCES "outbound_intents"("workspace_id", "channel_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_results" ADD CONSTRAINT "outbound_results_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_results" ADD CONSTRAINT "outbound_results_workspace_id_channel_id_attempt_id_fkey" FOREIGN KEY ("workspace_id", "channel_id", "attempt_id") REFERENCES "outbound_attempts"("workspace_id", "channel_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_bindings" ADD CONSTRAINT "outbound_bindings_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_bindings" ADD CONSTRAINT "outbound_bindings_workspace_id_channel_id_intent_id_fkey" FOREIGN KEY ("workspace_id", "channel_id", "intent_id") REFERENCES "outbound_intents"("workspace_id", "channel_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_bindings" ADD CONSTRAINT "outbound_bindings_workspace_id_channel_id_attempt_id_fkey" FOREIGN KEY ("workspace_id", "channel_id", "attempt_id") REFERENCES "outbound_attempts"("workspace_id", "channel_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_bindings" ADD CONSTRAINT "outbound_bindings_workspace_id_channel_id_result_id_fkey" FOREIGN KEY ("workspace_id", "channel_id", "result_id") REFERENCES "outbound_results"("workspace_id", "channel_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_bindings" ADD CONSTRAINT "outbound_bindings_workspace_id_channel_id_identity_id_fkey" FOREIGN KEY ("workspace_id", "channel_id", "identity_id") REFERENCES "canonical_message_identities"("workspace_id", "channel_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_bindings" ADD CONSTRAINT "outbound_bindings_workspace_id_channel_id_alias_id_fkey" FOREIGN KEY ("workspace_id", "channel_id", "alias_id") REFERENCES "canonical_native_aliases"("workspace_id", "channel_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_correlations" ADD CONSTRAINT "outbound_correlations_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_correlations" ADD CONSTRAINT "outbound_correlations_workspace_id_channel_id_conversation_fkey" FOREIGN KEY ("workspace_id", "channel_id", "conversation_id") REFERENCES "conversations"("workspace_id", "channel_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_correlations" ADD CONSTRAINT "outbound_correlations_workspace_id_conversation_id_message_fkey" FOREIGN KEY ("workspace_id", "conversation_id", "message_id") REFERENCES "messages"("workspace_id", "conversation_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

