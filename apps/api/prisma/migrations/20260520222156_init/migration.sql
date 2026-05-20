-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('owner', 'manager', 'agent');

-- CreateEnum
CREATE TYPE "ChannelProvider" AS ENUM ('evolution');

-- CreateEnum
CREATE TYPE "ChannelStatus" AS ENUM ('disconnected', 'connecting', 'connected', 'failed');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('open', 'pending', 'closed');

-- CreateEnum
CREATE TYPE "ConversationPriority" AS ENUM ('low', 'normal', 'high');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('text', 'image', 'audio', 'file', 'template', 'system', 'internal_note');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('pending', 'sent', 'delivered', 'read', 'failed');

-- CreateTable
CREATE TABLE "workspace_mirrors" (
    "workspace_id" TEXT NOT NULL,
    "name" TEXT,
    "plan" TEXT,
    "limits" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_mirrors_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "user_profiles" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "clerk_user_id" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'agent',
    "display_name" TEXT NOT NULL,
    "avatar_url" TEXT,
    "presence_state" TEXT NOT NULL DEFAULT 'offline',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channels" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "provider" "ChannelProvider" NOT NULL,
    "provider_key" TEXT NOT NULL,
    "phone_number" TEXT,
    "display_name" TEXT,
    "status" "ChannelStatus" NOT NULL DEFAULT 'disconnected',
    "encrypted_config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "company" TEXT,
    "avatar_url" TEXT,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "atomic_crm_contact_id" TEXT,
    "atomic_crm_lead_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "routing_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "status" "ConversationStatus" NOT NULL DEFAULT 'open',
    "assigned_user_id" UUID,
    "department_id" UUID,
    "last_message_at" TIMESTAMP(3),
    "last_message_preview" TEXT,
    "unread_count" INTEGER NOT NULL DEFAULT 0,
    "priority" "ConversationPriority" NOT NULL DEFAULT 'normal',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "conversation_id" UUID NOT NULL,
    "provider_message_id" TEXT,
    "provider_event_id" TEXT,
    "direction" "MessageDirection" NOT NULL,
    "type" "MessageType" NOT NULL,
    "body" TEXT,
    "media_url" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "status" "MessageStatus" NOT NULL DEFAULT 'pending',
    "sent_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_tags" (
    "workspace_id" TEXT NOT NULL,
    "conversation_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_tags_pkey" PRIMARY KEY ("workspace_id","conversation_id","tag_id")
);

-- CreateIndex
CREATE INDEX "user_profiles_workspace_id_role_idx" ON "user_profiles"("workspace_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "user_profiles_workspace_id_id_key" ON "user_profiles"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "user_profiles_workspace_id_clerk_user_id_key" ON "user_profiles"("workspace_id", "clerk_user_id");

-- CreateIndex
CREATE INDEX "channels_workspace_id_status_idx" ON "channels"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "channels_workspace_id_id_key" ON "channels"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "channels_workspace_id_provider_provider_key_key" ON "channels"("workspace_id", "provider", "provider_key");

-- CreateIndex
CREATE INDEX "contacts_workspace_id_name_idx" ON "contacts"("workspace_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_workspace_id_id_key" ON "contacts"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_workspace_id_phone_key" ON "contacts"("workspace_id", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_workspace_id_atomic_crm_contact_id_key" ON "contacts"("workspace_id", "atomic_crm_contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_workspace_id_atomic_crm_lead_id_key" ON "contacts"("workspace_id", "atomic_crm_lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_workspace_id_id_key" ON "departments"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_workspace_id_name_key" ON "departments"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "conversations_workspace_id_status_last_message_at_idx" ON "conversations"("workspace_id", "status", "last_message_at");

-- CreateIndex
CREATE INDEX "conversations_workspace_id_assigned_user_id_idx" ON "conversations"("workspace_id", "assigned_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_workspace_id_id_key" ON "conversations"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_workspace_id_channel_id_contact_id_key" ON "conversations"("workspace_id", "channel_id", "contact_id");

-- CreateIndex
CREATE INDEX "messages_workspace_id_conversation_id_created_at_idx" ON "messages"("workspace_id", "conversation_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_workspace_id_provider_event_id_key" ON "messages"("workspace_id", "provider_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_workspace_id_provider_message_id_key" ON "messages"("workspace_id", "provider_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "tags_workspace_id_id_key" ON "tags"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tags_workspace_id_name_key" ON "tags"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "conversation_tags_workspace_id_tag_id_idx" ON "conversation_tags"("workspace_id", "tag_id");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_assigned_user_id_fkey" FOREIGN KEY ("workspace_id", "assigned_user_id") REFERENCES "user_profiles"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_contact_id_fkey" FOREIGN KEY ("workspace_id", "contact_id") REFERENCES "contacts"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_department_id_fkey" FOREIGN KEY ("workspace_id", "department_id") REFERENCES "departments"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_conversation_id_fkey" FOREIGN KEY ("workspace_id", "conversation_id") REFERENCES "conversations"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_sent_by_user_id_fkey" FOREIGN KEY ("workspace_id", "sent_by_user_id") REFERENCES "user_profiles"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_tags" ADD CONSTRAINT "conversation_tags_workspace_id_conversation_id_fkey" FOREIGN KEY ("workspace_id", "conversation_id") REFERENCES "conversations"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_tags" ADD CONSTRAINT "conversation_tags_workspace_id_tag_id_fkey" FOREIGN KEY ("workspace_id", "tag_id") REFERENCES "tags"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
