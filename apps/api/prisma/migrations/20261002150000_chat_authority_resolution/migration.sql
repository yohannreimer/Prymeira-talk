-- Explicit operator choice of the operating conversation for a chat claimed by several conversations.
-- Additive: no existing row, UUID, FK or setting is touched. Membership stays in canonical_chat_members.
CREATE TABLE canonical_chat_authority_resolutions (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  channel_id UUID NOT NULL,
  chat_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  member_conversation_ids JSONB NOT NULL,
  resolved_by TEXT NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT canonical_chat_authority_resolutions_pkey PRIMARY KEY (id),
  CONSTRAINT canonical_chat_authority_resolutions_chat_fkey FOREIGN KEY (workspace_id, channel_id, chat_id) REFERENCES canonical_chats(workspace_id, channel_id, id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT canonical_chat_authority_resolutions_conversation_fkey FOREIGN KEY (workspace_id, channel_id, conversation_id) REFERENCES conversations(workspace_id, channel_id, id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX canonical_chat_authority_resolutions_chat_key ON canonical_chat_authority_resolutions(workspace_id, channel_id, chat_id);
