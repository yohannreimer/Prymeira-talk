ALTER TABLE automation_runs ADD COLUMN execution_token UUID;
ALTER TABLE automation_runs ADD COLUMN lease_until TIMESTAMPTZ;
CREATE INDEX automation_runs_status_lease_until_idx ON automation_runs(status, lease_until);

-- Message edits and removals use the same conservative dispatch journal.
ALTER TABLE outbound_dispatches DROP CONSTRAINT outbound_dispatches_kind_check;
ALTER TABLE outbound_dispatches ADD CONSTRAINT outbound_dispatches_kind_check
  CHECK (kind IN ('text', 'media', 'audio', 'contact', 'edit', 'delete'));
