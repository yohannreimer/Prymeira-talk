CREATE TABLE "broadcast_lists" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "broadcast_lists_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "broadcast_list_members" (
    "workspace_id" TEXT NOT NULL,
    "list_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "broadcast_list_members_pkey" PRIMARY KEY ("workspace_id","list_id","contact_id")
);

CREATE UNIQUE INDEX "broadcast_lists_workspace_id_id_key" ON "broadcast_lists"("workspace_id","id");
CREATE UNIQUE INDEX "broadcast_lists_workspace_id_name_key" ON "broadcast_lists"("workspace_id","name");
CREATE INDEX "broadcast_lists_workspace_id_updated_at_idx" ON "broadcast_lists"("workspace_id","updated_at");
CREATE INDEX "broadcast_list_members_workspace_id_contact_id_idx" ON "broadcast_list_members"("workspace_id","contact_id");

ALTER TABLE "broadcast_list_members" ADD CONSTRAINT "broadcast_list_members_workspace_id_list_id_fkey"
    FOREIGN KEY ("workspace_id","list_id") REFERENCES "broadcast_lists"("workspace_id","id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "broadcast_list_members" ADD CONSTRAINT "broadcast_list_members_workspace_id_contact_id_fkey"
    FOREIGN KEY ("workspace_id","contact_id") REFERENCES "contacts"("workspace_id","id") ON DELETE CASCADE ON UPDATE CASCADE;
