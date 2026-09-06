-- CreateTable
CREATE TABLE "assistant_conversation_states" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "conversation_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "last_message_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "first_pending_at" TIMESTAMP(3) NOT NULL,
    "scheduled_at" TIMESTAMP(3),
    "lease_token" UUID,
    "lease_until" TIMESTAMP(3),
    "requested_by_id" UUID,
    "instruction" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assistant_conversation_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_suggestions" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "conversation_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "revision" INTEGER NOT NULL,
    "context_key" TEXT NOT NULL,
    "agent_hash" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "instruction" TEXT,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "proposed_actions" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_suggestion_sends" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "request_key" UUID NOT NULL,
    "suggestion_id" UUID NOT NULL,
    "body_hash" TEXT NOT NULL,
    "final_body" TEXT NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "message_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assistant_suggestion_sends_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assistant_conversation_states_status_scheduled_at_idx" ON "assistant_conversation_states"("status", "scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "assistant_conversation_states_workspace_id_conversation_id_key" ON "assistant_conversation_states"("workspace_id", "conversation_id");

-- CreateIndex
CREATE INDEX "assistant_suggestions_workspace_id_conversation_id_created__idx" ON "assistant_suggestions"("workspace_id", "conversation_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "assistant_suggestions_workspace_id_id_key" ON "assistant_suggestions"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "assistant_suggestions_workspace_id_conversation_id_revision_key" ON "assistant_suggestions"("workspace_id", "conversation_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "assistant_suggestion_sends_suggestion_id_key" ON "assistant_suggestion_sends"("suggestion_id");

-- CreateIndex
CREATE UNIQUE INDEX "assistant_suggestion_sends_workspace_id_request_key_key" ON "assistant_suggestion_sends"("workspace_id", "request_key");

-- CreateIndex
CREATE UNIQUE INDEX "assistant_suggestion_sends_workspace_id_suggestion_id_key" ON "assistant_suggestion_sends"("workspace_id", "suggestion_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_workspace_id_id_key" ON "messages"("workspace_id", "id");

-- AddForeignKey
ALTER TABLE "assistant_conversation_states" ADD CONSTRAINT "assistant_conversation_states_workspace_id_conversation_id_fkey" FOREIGN KEY ("workspace_id", "conversation_id") REFERENCES "conversations"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_conversation_states" ADD CONSTRAINT "assistant_conversation_states_workspace_id_last_message_id_fkey" FOREIGN KEY ("workspace_id", "last_message_id") REFERENCES "messages"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_conversation_states" ADD CONSTRAINT "assistant_conversation_states_workspace_id_requested_by_id_fkey" FOREIGN KEY ("workspace_id", "requested_by_id") REFERENCES "user_profiles"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_suggestions" ADD CONSTRAINT "assistant_suggestions_workspace_id_conversation_id_fkey" FOREIGN KEY ("workspace_id", "conversation_id") REFERENCES "conversations"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_suggestions" ADD CONSTRAINT "assistant_suggestions_workspace_id_agent_id_fkey" FOREIGN KEY ("workspace_id", "agent_id") REFERENCES "ai_agents"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_suggestions" ADD CONSTRAINT "assistant_suggestions_workspace_id_actor_user_id_fkey" FOREIGN KEY ("workspace_id", "actor_user_id") REFERENCES "user_profiles"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_suggestion_sends" ADD CONSTRAINT "assistant_suggestion_sends_workspace_id_suggestion_id_fkey" FOREIGN KEY ("workspace_id", "suggestion_id") REFERENCES "assistant_suggestions"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_suggestion_sends" ADD CONSTRAINT "assistant_suggestion_sends_workspace_id_actor_user_id_fkey" FOREIGN KEY ("workspace_id", "actor_user_id") REFERENCES "user_profiles"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_suggestion_sends" ADD CONSTRAINT "assistant_suggestion_sends_workspace_id_message_id_fkey" FOREIGN KEY ("workspace_id", "message_id") REFERENCES "messages"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
