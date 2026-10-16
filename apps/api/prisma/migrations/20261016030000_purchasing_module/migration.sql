-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "contact_id" UUID,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "contact_name" TEXT,
    "email" TEXT,
    "cnpj" TEXT,
    "city" TEXT,
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "preferred" BOOLEAN NOT NULL DEFAULT false,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_requests" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "response_deadline" TIMESTAMP(3) NOT NULL,
    "delivery_deadline" TIMESTAMP(3) NOT NULL,
    "delivery_cep" TEXT NOT NULL,
    "delivery_city" TEXT,
    "budget_ceiling_cents" INTEGER,
    "payment_preference" TEXT,
    "requires_invoice" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "negotiation_rules" JSONB NOT NULL DEFAULT '{}',
    "channel_id" UUID,
    "created_by_user_id" TEXT,
    "approved_invite_id" UUID,
    "approved_at" TIMESTAMP(3),
    "approved_by_user_id" TEXT,
    "started_at" TIMESTAMP(3),
    "canceled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_request_items" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "request_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "specification" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "reference_urls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_request_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_quote_invites" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "request_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "conversation_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "ficha" JSONB NOT NULL DEFAULT '{}',
    "followup_count" INTEGER NOT NULL DEFAULT 0,
    "declined_reason" TEXT,
    "sent_at" TIMESTAMP(3),
    "last_reply_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_quote_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_quotes" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "invite_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'initial',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "freight_cents" INTEGER,
    "delivery_text" TEXT,
    "delivery_date" TIMESTAMP(3),
    "payment_terms" TEXT,
    "valid_until" TIMESTAMP(3),
    "observation" TEXT,
    "origin" TEXT,
    "source_message_id" UUID,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_quote_lines" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "quote_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "unit_price_cents" INTEGER NOT NULL,
    "note" TEXT,

    CONSTRAINT "purchase_quote_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_events" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "request_id" UUID NOT NULL,
    "invite_id" UUID,
    "type" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "reason" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "actor_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_history" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "item_name" TEXT NOT NULL,
    "item_key" TEXT NOT NULL,
    "supplier_id" UUID,
    "supplier_name" TEXT,
    "unit" TEXT,
    "quantity" DOUBLE PRECISION,
    "unit_price_cents" INTEGER NOT NULL,
    "paid_at" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'import',
    "request_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "suppliers_workspace_id_name_idx" ON "suppliers"("workspace_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_workspace_id_id_key" ON "suppliers"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_workspace_id_phone_key" ON "suppliers"("workspace_id", "phone");

-- CreateIndex
CREATE INDEX "purchase_requests_workspace_id_status_updated_at_idx" ON "purchase_requests"("workspace_id", "status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_requests_workspace_id_id_key" ON "purchase_requests"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_request_items_workspace_id_id_key" ON "purchase_request_items"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_request_items_request_id_position_key" ON "purchase_request_items"("request_id", "position");

-- CreateIndex
CREATE INDEX "purchase_quote_invites_workspace_id_conversation_id_idx" ON "purchase_quote_invites"("workspace_id", "conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_quote_invites_workspace_id_id_key" ON "purchase_quote_invites"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_quote_invites_request_id_supplier_id_key" ON "purchase_quote_invites"("request_id", "supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_quotes_workspace_id_id_key" ON "purchase_quotes"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_quotes_invite_id_version_key" ON "purchase_quotes"("invite_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_quote_lines_quote_id_item_id_key" ON "purchase_quote_lines"("quote_id", "item_id");

-- CreateIndex
CREATE INDEX "purchase_events_workspace_id_request_id_created_at_idx" ON "purchase_events"("workspace_id", "request_id", "created_at");

-- CreateIndex
CREATE INDEX "price_history_workspace_id_item_key_paid_at_idx" ON "price_history"("workspace_id", "item_key", "paid_at");

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_workspace_id_contact_id_fkey" FOREIGN KEY ("workspace_id", "contact_id") REFERENCES "contacts"("workspace_id", "id") ON DELETE SET NULL ("contact_id") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_request_items" ADD CONSTRAINT "purchase_request_items_workspace_id_request_id_fkey" FOREIGN KEY ("workspace_id", "request_id") REFERENCES "purchase_requests"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_quote_invites" ADD CONSTRAINT "purchase_quote_invites_workspace_id_request_id_fkey" FOREIGN KEY ("workspace_id", "request_id") REFERENCES "purchase_requests"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_quote_invites" ADD CONSTRAINT "purchase_quote_invites_workspace_id_supplier_id_fkey" FOREIGN KEY ("workspace_id", "supplier_id") REFERENCES "suppliers"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_quotes" ADD CONSTRAINT "purchase_quotes_workspace_id_invite_id_fkey" FOREIGN KEY ("workspace_id", "invite_id") REFERENCES "purchase_quote_invites"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_quote_lines" ADD CONSTRAINT "purchase_quote_lines_workspace_id_quote_id_fkey" FOREIGN KEY ("workspace_id", "quote_id") REFERENCES "purchase_quotes"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_quote_lines" ADD CONSTRAINT "purchase_quote_lines_workspace_id_item_id_fkey" FOREIGN KEY ("workspace_id", "item_id") REFERENCES "purchase_request_items"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_events" ADD CONSTRAINT "purchase_events_workspace_id_request_id_fkey" FOREIGN KEY ("workspace_id", "request_id") REFERENCES "purchase_requests"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_workspace_id_supplier_id_fkey" FOREIGN KEY ("workspace_id", "supplier_id") REFERENCES "suppliers"("workspace_id", "id") ON DELETE SET NULL ("supplier_id") ON UPDATE CASCADE;


-- State checks (same convention as the other durable tables)
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_status_check" CHECK ("status" IN ('draft','quoting','awaiting_approval','approved','canceled','completed'));
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_budget_check" CHECK ("budget_ceiling_cents" IS NULL OR "budget_ceiling_cents" > 0);
ALTER TABLE "purchase_request_items" ADD CONSTRAINT "purchase_request_items_quantity_check" CHECK ("quantity" > 0);
ALTER TABLE "purchase_quote_invites" ADD CONSTRAINT "purchase_quote_invites_status_check" CHECK ("status" IN ('queued','sent','replied','no_response','declined','quote_received','negotiating','winner','lost'));
ALTER TABLE "purchase_quotes" ADD CONSTRAINT "purchase_quotes_kind_check" CHECK ("kind" IN ('initial','choradinha','counter','correction'));
ALTER TABLE "purchase_quotes" ADD CONSTRAINT "purchase_quotes_source_check" CHECK ("source" IN ('agent','manual'));
ALTER TABLE "purchase_quotes" ADD CONSTRAINT "purchase_quotes_freight_check" CHECK ("freight_cents" IS NULL OR "freight_cents" >= 0);
ALTER TABLE "purchase_quote_lines" ADD CONSTRAINT "purchase_quote_lines_price_check" CHECK ("unit_price_cents" >= 0);
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_source_check" CHECK ("source" IN ('import','request'));
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_price_check" CHECK ("unit_price_cents" >= 0);
