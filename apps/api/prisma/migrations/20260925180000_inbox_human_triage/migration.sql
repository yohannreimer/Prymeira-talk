CREATE TYPE "InboxReplyDecision" AS ENUM ('needs_reply', 'no_reply', 'uncertain');

CREATE TABLE "conversation_inbox_triage" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "conversation_id" UUID NOT NULL,
    "manual_marked_at" TIMESTAMP(3),
    "manual_marked_by_id" UUID,
    "last_observed_message_id" UUID,
    "anchor_message_id" UUID,
    "decision" "InboxReplyDecision",
    "reason" TEXT,
    "model" TEXT,
    "analyzed_at" TIMESTAMP(3),
    "dismissed_message_id" UUID,
    "dismissed_at" TIMESTAMP(3),
    "due_at" TIMESTAMP(3),
    "lock_token" UUID,
    "locked_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "conversation_inbox_triage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "conversation_inbox_triage_workspace_id_conversation_id_key"
    ON "conversation_inbox_triage"("workspace_id", "conversation_id");
CREATE INDEX "conversation_inbox_triage_due_at_locked_at_idx"
    ON "conversation_inbox_triage"("due_at", "locked_at");
CREATE INDEX "conversation_inbox_triage_workspace_id_manual_marked_at_idx"
    ON "conversation_inbox_triage"("workspace_id", "manual_marked_at");
CREATE INDEX "conversation_inbox_triage_workspace_id_decision_idx"
    ON "conversation_inbox_triage"("workspace_id", "decision");

ALTER TABLE "conversation_inbox_triage"
    ADD CONSTRAINT "conversation_inbox_triage_workspace_id_conversation_id_fkey"
    FOREIGN KEY ("workspace_id", "conversation_id")
    REFERENCES "conversations"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
