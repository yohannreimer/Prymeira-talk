-- DropForeignKey
ALTER TABLE "contact_notes" DROP CONSTRAINT "contact_notes_workspace_id_conversation_id_fkey";

-- AddForeignKey
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_workspace_id_conversation_id_fkey" FOREIGN KEY ("workspace_id", "conversation_id") REFERENCES "conversations"("workspace_id", "id") ON DELETE SET NULL ("conversation_id") ON UPDATE CASCADE;
