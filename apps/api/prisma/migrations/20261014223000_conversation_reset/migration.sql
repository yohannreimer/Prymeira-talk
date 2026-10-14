ALTER TABLE conversations ADD COLUMN history_reset_at TIMESTAMP(3);
ALTER TABLE messages ADD COLUMN hidden_by_reset BOOLEAN NOT NULL DEFAULT false;

-- Retain immutable receipt/identity/delivery bindings; hide their operational projection.
-- Sticky even when later enrichment changes timestamps or moves a historical row.
CREATE FUNCTION enforce_message_reset_visibility() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reset_at TIMESTAMP(3);
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.hidden_by_reset THEN
    NEW.hidden_by_reset := true;
    RETURN NEW;
  END IF;
  SELECT GREATEST(c.history_reset_at, operating.history_reset_at) INTO reset_at
    FROM conversations c
    LEFT JOIN conversations operating ON operating.workspace_id = c.workspace_id
      AND operating.id = c.retired_into_conversation_id
    WHERE c.workspace_id = NEW.workspace_id AND c.id = NEW.conversation_id;
  IF reset_at IS NOT NULL AND NEW.created_at <= reset_at THEN
    NEW.hidden_by_reset := true;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER messages_reset_visibility BEFORE INSERT OR UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION enforce_message_reset_visibility();
