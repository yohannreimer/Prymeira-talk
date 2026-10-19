ALTER TABLE outbound_dispatches DROP CONSTRAINT outbound_dispatches_kind_check;
ALTER TABLE outbound_dispatches ADD CONSTRAINT outbound_dispatches_kind_check
  CHECK (kind IN ('text', 'media', 'audio', 'contact', 'template', 'edit', 'delete'));
