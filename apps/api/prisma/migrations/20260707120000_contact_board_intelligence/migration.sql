CREATE TYPE "ContactBoardMoveSource" AS ENUM ('manual', 'rule');

ALTER TABLE "contact_boards" ADD COLUMN "is_primary_pipeline" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "contact_board_memberships" ADD COLUMN "last_moved_by" "ContactBoardMoveSource" NOT NULL DEFAULT 'manual';
ALTER TABLE "contact_board_memberships" ADD COLUMN "last_rule_applied_at" TIMESTAMP(3);

CREATE TABLE "contact_board_channels" (
  "workspace_id" TEXT NOT NULL,
  "board_id" UUID NOT NULL,
  "channel_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "contact_board_channels_pkey" PRIMARY KEY ("workspace_id", "board_id", "channel_id")
);

CREATE INDEX "contact_board_channels_workspace_id_channel_id_idx" ON "contact_board_channels"("workspace_id", "channel_id");

CREATE TABLE "contact_board_stage_tags" (
  "workspace_id" TEXT NOT NULL,
  "board_id" UUID NOT NULL,
  "stage_id" UUID NOT NULL,
  "tag_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "contact_board_stage_tags_pkey" PRIMARY KEY ("workspace_id", "board_id", "tag_id")
);

CREATE INDEX "contact_board_stage_tags_workspace_id_board_id_stage_id_idx" ON "contact_board_stage_tags"("workspace_id", "board_id", "stage_id");

ALTER TABLE "contact_board_channels" ADD CONSTRAINT "contact_board_channels_workspace_id_board_id_fkey" FOREIGN KEY ("workspace_id", "board_id") REFERENCES "contact_boards"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contact_board_channels" ADD CONSTRAINT "contact_board_channels_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "contact_board_stage_tags" ADD CONSTRAINT "contact_board_stage_tags_workspace_id_board_id_stage_id_fkey" FOREIGN KEY ("workspace_id", "board_id", "stage_id") REFERENCES "contact_board_stages"("workspace_id", "board_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contact_board_stage_tags" ADD CONSTRAINT "contact_board_stage_tags_workspace_id_tag_id_fkey" FOREIGN KEY ("workspace_id", "tag_id") REFERENCES "tags"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
