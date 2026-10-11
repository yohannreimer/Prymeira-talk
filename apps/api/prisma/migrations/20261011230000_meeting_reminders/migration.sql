CREATE TABLE "meeting_reminders" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "conversation_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "meeting_starts_at" TIMESTAMP(3) NOT NULL,
    "minutes_before" INTEGER NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "locked_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_reminders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "meeting_reminders_status_due_at_idx"
  ON "meeting_reminders"("status", "due_at");

CREATE INDEX "meeting_reminders_workspace_id_conversation_id_status_idx"
  ON "meeting_reminders"("workspace_id", "conversation_id", "status");

ALTER TABLE "meeting_reminders"
  ADD CONSTRAINT "meeting_reminders_workspace_id_conversation_id_fkey"
  FOREIGN KEY ("workspace_id", "conversation_id") REFERENCES "conversations"("workspace_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
