-- Additive: pairs of AI suggestion and the seller's actual reply, for training. No existing table is touched.
CREATE TABLE "assistant_reply_samples" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "conversation_id" UUID NOT NULL,
    "suggestion_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "suggested_body" TEXT NOT NULL,
    "reply_body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_reply_samples_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "assistant_reply_samples_workspace_id_message_id_key" ON "assistant_reply_samples"("workspace_id", "message_id");
CREATE INDEX "assistant_reply_samples_workspace_id_created_at_idx" ON "assistant_reply_samples"("workspace_id", "created_at");
