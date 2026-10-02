-- A conversation retired by an authority resolution points at the conversation that now operates its chat. It stays
-- in the database untouched (messages, settings, UUID); lists skip it and the operating conversation shows its history.
ALTER TABLE conversations ADD COLUMN retired_into_conversation_id UUID;
CREATE INDEX conversations_workspace_retired_into_idx ON conversations(workspace_id, retired_into_conversation_id);
