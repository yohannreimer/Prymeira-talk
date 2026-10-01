-- Exact ownership of the existing preview cache. No inferred legacy backfill.
CREATE TABLE conversation_preview_owners (
  conversation_id UUID NOT NULL,
  workspace_id TEXT NOT NULL,
  channel_id UUID NOT NULL,
  message_id UUID NOT NULL,
  CONSTRAINT conversation_preview_owners_pkey PRIMARY KEY(conversation_id),
  CONSTRAINT conversation_preview_owners_scope_key UNIQUE(workspace_id,channel_id,conversation_id),
  CONSTRAINT conversation_preview_owners_conversation_fkey FOREIGN KEY(workspace_id,channel_id,conversation_id)
    REFERENCES conversations(workspace_id,channel_id,id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT conversation_preview_owners_message_fkey FOREIGN KEY(workspace_id,conversation_id,message_id)
    REFERENCES messages(workspace_id,conversation_id,id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX conversation_preview_owners_message_idx ON conversation_preview_owners(workspace_id,conversation_id,message_id);
-- Even SET preview=preview is an uncertified cache write. Canonical helpers write
-- the cache first, then its exact Message UUID proof in the same locked transaction.
CREATE FUNCTION invalidate_conversation_preview_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM conversation_preview_owners WHERE conversation_id=NEW.id;
  RETURN NEW;
END $$;
CREATE TRIGGER conversation_preview_owner_invalidation
  AFTER UPDATE OF last_message_preview,last_message_preview_at ON conversations
  FOR EACH ROW EXECUTE FUNCTION invalidate_conversation_preview_owner();
