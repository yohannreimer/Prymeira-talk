BEGIN;
-- CreateTable
CREATE TABLE "canonical_addresses" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" UUID NOT NULL,
    "redirect_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "canonical_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canonical_address_aliases" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" UUID NOT NULL,
    "address_id" UUID NOT NULL,
    "address" VARCHAR(100) NOT NULL,

    CONSTRAINT "canonical_address_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canonical_address_evidence" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" UUID NOT NULL,
    "observation_id" UUID NOT NULL,
    "lid" VARCHAR(100) NOT NULL,
    "pn" VARCHAR(100) NOT NULL,
    "role" TEXT NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "canonical_address_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canonical_chats" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" UUID NOT NULL,
    "address_id" UUID NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'active',
    "review_reason" TEXT,
    "operation_conversation_id" UUID,
    "revision" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "canonical_chats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canonical_chat_members" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "canonical_chat_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canonical_message_identities" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "sender_address_id" UUID,
    "conversation_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "identity_format" TEXT NOT NULL,
    "provider_scope" TEXT NOT NULL,
    "raw_id" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "tuple_hash" VARCHAR(64) NOT NULL,
    "full_tuple" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'active',
    "current_revision" JSONB,
    "initial_mode" TEXT NOT NULL,

    CONSTRAINT "canonical_message_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canonical_native_aliases" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" UUID NOT NULL,
    "channel_provider" "ChannelProvider" NOT NULL,
    "provider" TEXT NOT NULL,
    "connection_provider" "ChannelConnectionProvider",
    "connection_id" UUID,
    "identity_id" UUID,
    "tuple_hash" VARCHAR(64) NOT NULL,
    "full_tuple" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'unresolved',

    CONSTRAINT "canonical_native_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canonical_observations" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" UUID NOT NULL,
    "channel_provider" "ChannelProvider" NOT NULL,
    "provider" TEXT NOT NULL,
    "connection_provider" "ChannelConnectionProvider",
    "connection_id" UUID,
    "identity_id" UUID,
    "alias_id" UUID,
    "receipt_hash" VARCHAR(64) NOT NULL,
    "receipt_tuple" JSONB NOT NULL,
    "provider_event_id" TEXT,
    "kind" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "source" TEXT,
    "session_name" TEXT NOT NULL,
    "lifecycle_generation" INTEGER NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "current_revision" JSONB,
    "source_order" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'held',
    "reason" TEXT,

    CONSTRAINT "canonical_observations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "canonical_addresses_workspace_id_channel_id_id_key" ON "canonical_addresses"("workspace_id", "channel_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_address_aliases_workspace_id_channel_id_address_key" ON "canonical_address_aliases"("workspace_id", "channel_id", "address");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_address_evidence_observation_id_lid_pn_role_sourc_key" ON "canonical_address_evidence"("observation_id", "lid", "pn", "role", "source");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_chats_workspace_id_channel_id_id_key" ON "canonical_chats"("workspace_id", "channel_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_chats_workspace_id_channel_id_address_id_key" ON "canonical_chats"("workspace_id", "channel_id", "address_id");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_chat_members_workspace_id_channel_id_chat_id_conv_key" ON "canonical_chat_members"("workspace_id", "channel_id", "chat_id", "conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_message_identities_message_id_key" ON "canonical_message_identities"("message_id");

-- CreateIndex
CREATE INDEX "canonical_message_identities_workspace_id_channel_id_tuple__idx" ON "canonical_message_identities"("workspace_id", "channel_id", "tuple_hash");

-- CreateIndex
CREATE INDEX "canonical_message_identities_workspace_id_channel_id_chat_i_idx" ON "canonical_message_identities"("workspace_id", "channel_id", "chat_id");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_message_identities_workspace_id_channel_id_id_key" ON "canonical_message_identities"("workspace_id", "channel_id", "id");

-- CreateIndex
CREATE INDEX "canonical_native_aliases_workspace_id_channel_id_tuple_hash_idx" ON "canonical_native_aliases"("workspace_id", "channel_id", "tuple_hash");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_native_aliases_workspace_id_channel_id_id_key" ON "canonical_native_aliases"("workspace_id", "channel_id", "id");

-- CreateIndex
CREATE INDEX "canonical_observations_workspace_id_channel_id_receipt_hash_idx" ON "canonical_observations"("workspace_id", "channel_id", "receipt_hash");

-- CreateIndex
CREATE INDEX "canonical_observations_workspace_id_channel_id_state_idx" ON "canonical_observations"("workspace_id", "channel_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_observations_workspace_id_channel_id_id_key" ON "canonical_observations"("workspace_id", "channel_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "channels_workspace_id_id_provider_key" ON "channels"("workspace_id", "id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "channel_connections_workspace_id_channel_id_provider_id_key" ON "channel_connections"("workspace_id", "channel_id", "provider", "id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_workspace_id_channel_id_id_key" ON "conversations"("workspace_id", "channel_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_workspace_id_conversation_id_id_key" ON "messages"("workspace_id", "conversation_id", "id");

-- AddForeignKey
ALTER TABLE "canonical_addresses" ADD CONSTRAINT "canonical_addresses_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_addresses" ADD CONSTRAINT "canonical_addresses_workspace_id_channel_id_redirect_id_fkey" FOREIGN KEY ("workspace_id", "channel_id", "redirect_id") REFERENCES "canonical_addresses"("workspace_id", "channel_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_address_aliases" ADD CONSTRAINT "canonical_address_aliases_workspace_id_channel_id_address__fkey" FOREIGN KEY ("workspace_id", "channel_id", "address_id") REFERENCES "canonical_addresses"("workspace_id", "channel_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_address_evidence" ADD CONSTRAINT "canonical_address_evidence_workspace_id_channel_id_observa_fkey" FOREIGN KEY ("workspace_id", "channel_id", "observation_id") REFERENCES "canonical_observations"("workspace_id", "channel_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_chats" ADD CONSTRAINT "canonical_chats_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_chats" ADD CONSTRAINT "canonical_chats_workspace_id_channel_id_address_id_fkey" FOREIGN KEY ("workspace_id", "channel_id", "address_id") REFERENCES "canonical_addresses"("workspace_id", "channel_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_chats" ADD CONSTRAINT "canonical_chats_workspace_id_channel_id_operation_conversa_fkey" FOREIGN KEY ("workspace_id", "channel_id", "operation_conversation_id") REFERENCES "conversations"("workspace_id", "channel_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_chat_members" ADD CONSTRAINT "canonical_chat_members_workspace_id_channel_id_chat_id_fkey" FOREIGN KEY ("workspace_id", "channel_id", "chat_id") REFERENCES "canonical_chats"("workspace_id", "channel_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_chat_members" ADD CONSTRAINT "canonical_chat_members_workspace_id_channel_id_conversatio_fkey" FOREIGN KEY ("workspace_id", "channel_id", "conversation_id") REFERENCES "conversations"("workspace_id", "channel_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_message_identities" ADD CONSTRAINT "canonical_message_identities_workspace_id_channel_id_chat__fkey" FOREIGN KEY ("workspace_id", "channel_id", "chat_id") REFERENCES "canonical_chats"("workspace_id", "channel_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_message_identities" ADD CONSTRAINT "canonical_message_identities_workspace_id_channel_id_sende_fkey" FOREIGN KEY ("workspace_id", "channel_id", "sender_address_id") REFERENCES "canonical_addresses"("workspace_id", "channel_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_message_identities" ADD CONSTRAINT "canonical_message_identities_workspace_id_channel_id_conve_fkey" FOREIGN KEY ("workspace_id", "channel_id", "conversation_id") REFERENCES "conversations"("workspace_id", "channel_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_message_identities" ADD CONSTRAINT "canonical_message_identities_workspace_id_conversation_id__fkey" FOREIGN KEY ("workspace_id", "conversation_id", "message_id") REFERENCES "messages"("workspace_id", "conversation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_native_aliases" ADD CONSTRAINT "canonical_native_aliases_workspace_id_channel_id_channel_p_fkey" FOREIGN KEY ("workspace_id", "channel_id", "channel_provider") REFERENCES "channels"("workspace_id", "id", "provider") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_native_aliases" ADD CONSTRAINT "canonical_native_aliases_workspace_id_channel_id_connectio_fkey" FOREIGN KEY ("workspace_id", "channel_id", "connection_provider", "connection_id") REFERENCES "channel_connections"("workspace_id", "channel_id", "provider", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_native_aliases" ADD CONSTRAINT "canonical_native_aliases_workspace_id_channel_id_identity__fkey" FOREIGN KEY ("workspace_id", "channel_id", "identity_id") REFERENCES "canonical_message_identities"("workspace_id", "channel_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_observations" ADD CONSTRAINT "canonical_observations_workspace_id_channel_id_channel_pro_fkey" FOREIGN KEY ("workspace_id", "channel_id", "channel_provider") REFERENCES "channels"("workspace_id", "id", "provider") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_observations" ADD CONSTRAINT "canonical_observations_workspace_id_channel_id_connection__fkey" FOREIGN KEY ("workspace_id", "channel_id", "connection_provider", "connection_id") REFERENCES "channel_connections"("workspace_id", "channel_id", "provider", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_observations" ADD CONSTRAINT "canonical_observations_workspace_id_channel_id_identity_id_fkey" FOREIGN KEY ("workspace_id", "channel_id", "identity_id") REFERENCES "canonical_message_identities"("workspace_id", "channel_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_observations" ADD CONSTRAINT "canonical_observations_workspace_id_channel_id_alias_id_fkey" FOREIGN KEY ("workspace_id", "channel_id", "alias_id") REFERENCES "canonical_native_aliases"("workspace_id", "channel_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Provider origin is distinct from physical transport. Official Meta will be wired in 2a.3.
ALTER TABLE canonical_native_aliases ADD CONSTRAINT canonical_alias_provider_scope CHECK (
  provider IN ('evolution','waha','meta_official') AND
  ((connection_id IS NULL AND connection_provider IS NULL) OR
   (connection_id IS NOT NULL AND connection_provider IS NOT NULL AND provider=connection_provider::text)) AND
  (provider <> 'waha' OR (channel_provider='evolution' AND connection_id IS NOT NULL)) AND
  (provider <> 'meta_official' OR (channel_provider='meta_cloud' AND connection_id IS NULL)) AND
  (channel_provider='evolution' OR connection_id IS NULL)
);
ALTER TABLE canonical_observations ADD CONSTRAINT canonical_observation_provider_scope CHECK (
  provider IN ('evolution','waha','meta_official') AND
  ((connection_id IS NULL AND connection_provider IS NULL) OR
   (connection_id IS NOT NULL AND connection_provider IS NOT NULL AND provider=connection_provider::text)) AND
  (provider <> 'waha' OR (channel_provider='evolution' AND connection_id IS NOT NULL)) AND
  (provider <> 'meta_official' OR (channel_provider='meta_cloud' AND connection_id IS NULL)) AND
  (channel_provider='evolution' OR connection_id IS NULL)
);
ALTER TABLE canonical_address_evidence ADD CONSTRAINT canonical_mapping_evidence CHECK (
  role IN ('chat','sender') AND source IN ('evolution.remoteJidAlt','evolution.participantAlt','waha.lid_lookup')
  AND lid ~ '^[0-9]+@lid$' AND pn ~ '^[0-9]+@s.whatsapp.net$'
);
ALTER TABLE canonical_chats ADD CONSTRAINT canonical_chat_review_authority CHECK (
  state IN ('active','review','redirected') AND (state='active' OR operation_conversation_id IS NULL)
);
ALTER TABLE canonical_observations ADD CONSTRAINT canonical_observation_mode CHECK (mode IN ('live','history','recovered_live'));

-- Only addresses directly demonstrated by the conversation's own Contact are backfilled.
-- custom_fields.evolutionLid is editable candidate data, never mapping evidence.
CREATE TEMP TABLE canonical_legacy_chats ON COMMIT DROP AS
SELECT c.workspace_id,c.channel_id,c.id AS conversation_id,
  CASE
    WHEN t.phone ~ '^[0-9]+(@lid|(-[0-9]+)?@g.us)$' THEN t.phone
    WHEN t.phone ~ '^[0-9]{8,15}$' THEN
      (CASE WHEN t.phone ~ '^55[0-9]{2}9[0-9]{8}$' THEN substring(t.phone,1,4)||substring(t.phone,6) ELSE t.phone END)||'@s.whatsapp.net'
  END AS address
FROM conversations c JOIN contacts t ON t.workspace_id=c.workspace_id AND t.id=c.contact_id;
DELETE FROM canonical_legacy_chats WHERE address IS NULL OR length(address)>100;
INSERT INTO canonical_addresses(id,workspace_id,channel_id)
SELECT DISTINCT md5(jsonb_build_array('canonical-address',workspace_id,channel_id,address)::text)::uuid,workspace_id,channel_id FROM canonical_legacy_chats;
INSERT INTO canonical_address_aliases(id,workspace_id,channel_id,address_id,address)
SELECT DISTINCT md5(jsonb_build_array('canonical-address-alias',workspace_id,channel_id,address)::text)::uuid,workspace_id,channel_id,
  md5(jsonb_build_array('canonical-address',workspace_id,channel_id,address)::text)::uuid,address FROM canonical_legacy_chats;
INSERT INTO canonical_chats(id,workspace_id,channel_id,address_id,state,review_reason,operation_conversation_id)
SELECT md5(jsonb_build_array('canonical-chat',workspace_id,channel_id,address)::text)::uuid,workspace_id,channel_id,
  md5(jsonb_build_array('canonical-address',workspace_id,channel_id,address)::text)::uuid,
  CASE WHEN count(*)=1 THEN 'active' ELSE 'review' END,
  CASE WHEN count(*)>1 THEN 'multiple_conversation_authorities' END,
  CASE WHEN count(*)=1 THEN min(conversation_id::text)::uuid END
FROM canonical_legacy_chats GROUP BY workspace_id,channel_id,address;
INSERT INTO canonical_chat_members(id,workspace_id,channel_id,chat_id,conversation_id,source)
SELECT md5(jsonb_build_array('canonical-member',workspace_id,channel_id,conversation_id)::text)::uuid,workspace_id,channel_id,
 md5(jsonb_build_array('canonical-chat',workspace_id,channel_id,address)::text)::uuid,conversation_id,'legacy_contact_address' FROM canonical_legacy_chats;

-- Preserve native IDs with exact legacy origin references. Even group records missing sender
-- survive as unresolved aliases; adoption requires explicit identity evidence at the API.
INSERT INTO canonical_native_aliases(id,workspace_id,channel_id,channel_provider,provider,tuple_hash,full_tuple,state)
SELECT md5(jsonb_build_array('canonical-legacy-alias',m.id)::text)::uuid,m.workspace_id,c.channel_id,ch.provider,
 CASE WHEN ch.provider='meta_cloud' AND m.provider_event_id LIKE 'meta:%' THEN 'meta_official' ELSE 'evolution' END,
 md5(jsonb_build_array('legacy',m.id)::text),
 jsonb_build_object('origin','legacy','messageId',m.id,'conversationId',m.conversation_id,'nativeId',m.provider_message_id,
   'direction',m.direction,'contactAddress',l.address,'groupSender',m.metadata->'groupSender'), 'unresolved'
FROM messages m JOIN conversations c ON c.workspace_id=m.workspace_id AND c.id=m.conversation_id
 JOIN channels ch ON ch.workspace_id=c.workspace_id AND ch.id=c.channel_id
 LEFT JOIN canonical_legacy_chats l ON l.workspace_id=c.workspace_id AND l.conversation_id=c.id
WHERE m.provider_message_id IS NOT NULL;

COMMIT;
