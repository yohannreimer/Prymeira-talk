-- Later certification of events held as stale_source (they arrived while a connection was being paired or reset).
-- Additive and append-only: ingress_event_progress stays an immutable fact; this table records the outcome after it.
CREATE TABLE ingress_event_recertifications (
  workspace_id TEXT NOT NULL,
  channel_id UUID NOT NULL,
  receipt_id UUID NOT NULL,
  event_index INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT,
  observation_id UUID,
  conversation_id UUID,
  message_id UUID,
  result JSONB NOT NULL,
  certified_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ingress_event_recertifications_pkey PRIMARY KEY (receipt_id, event_index),
  CONSTRAINT ingress_recertification_outcome CHECK (outcome IN ('applied', 'held', 'superseded')),
  CONSTRAINT ingress_recertification_progress_fkey FOREIGN KEY (workspace_id, channel_id, receipt_id, event_index) REFERENCES ingress_event_progress(workspace_id, channel_id, receipt_id, event_index) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX ingress_recertification_scope_event_key ON ingress_event_recertifications(workspace_id, channel_id, receipt_id, event_index);
CREATE TRIGGER ingress_recertification_immutable BEFORE UPDATE ON ingress_event_recertifications FOR EACH ROW EXECUTE FUNCTION ingress_immutable_fact();
