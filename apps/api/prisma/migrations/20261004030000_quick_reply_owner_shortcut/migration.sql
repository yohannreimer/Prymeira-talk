-- Personal quick replies with a "/" shortcut. Existing rows keep owner NULL: they stay visible to the whole team.
ALTER TABLE "quick_replies" ADD COLUMN "owner_user_id" TEXT;
ALTER TABLE "quick_replies" ADD COLUMN "shortcut" TEXT;
CREATE INDEX "quick_replies_workspace_id_owner_user_id_idx" ON "quick_replies"("workspace_id", "owner_user_id");
