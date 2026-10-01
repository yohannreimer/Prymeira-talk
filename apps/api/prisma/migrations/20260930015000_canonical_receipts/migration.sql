-- CreateTable
CREATE TABLE "canonical_recipient_receipts" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "recipient" VARCHAR(100) NOT NULL,
    "status" "MessageStatus" NOT NULL,
    "played" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "canonical_recipient_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "canonical_recipient_receipts_workspace_id_channel_id_identi_key" ON "canonical_recipient_receipts"("workspace_id", "channel_id", "identity_id", "recipient");

-- AddForeignKey
ALTER TABLE "canonical_recipient_receipts" ADD CONSTRAINT "canonical_recipient_receipts_workspace_id_channel_id_ident_fkey" FOREIGN KEY ("workspace_id", "channel_id", "identity_id") REFERENCES "canonical_message_identities"("workspace_id", "channel_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
