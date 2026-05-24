CREATE TABLE "quick_replies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quick_replies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "quick_replies_workspace_id_id_key" ON "quick_replies"("workspace_id", "id");
CREATE INDEX "quick_replies_workspace_id_category_idx" ON "quick_replies"("workspace_id", "category");
CREATE INDEX "quick_replies_workspace_id_updated_at_idx" ON "quick_replies"("workspace_id", "updated_at");
