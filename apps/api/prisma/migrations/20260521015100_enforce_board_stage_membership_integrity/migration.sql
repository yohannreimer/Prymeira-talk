-- DropForeignKey
ALTER TABLE "contact_board_memberships" DROP CONSTRAINT "contact_board_memberships_workspace_id_stage_id_fkey";

-- CreateIndex
CREATE UNIQUE INDEX "contact_board_stages_workspace_id_board_id_id_key" ON "contact_board_stages"("workspace_id", "board_id", "id");

-- AddForeignKey
ALTER TABLE "contact_board_memberships" ADD CONSTRAINT "contact_board_memberships_workspace_id_board_id_stage_id_fkey" FOREIGN KEY ("workspace_id", "board_id", "stage_id") REFERENCES "contact_board_stages"("workspace_id", "board_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
