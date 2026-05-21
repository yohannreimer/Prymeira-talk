-- AddForeignKey
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_workspace_id_conversation_id_fkey" FOREIGN KEY ("workspace_id", "conversation_id") REFERENCES "conversations"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_workspace_id_created_by_id_fkey" FOREIGN KEY ("workspace_id", "created_by_id") REFERENCES "user_profiles"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
