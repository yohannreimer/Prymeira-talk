-- One row per logical send that went through the outbound router. It records which physical connection
-- carried it and, above all, sends whose outcome is uncertain so they are reviewed, never resent blindly.
-- No message content beyond a short preview; no provider credentials.
CREATE TABLE outbound_dispatches (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  channel_id UUID NOT NULL,
  kind TEXT NOT NULL,
  destination TEXT NOT NULL,
  preview TEXT,
  state TEXT NOT NULL DEFAULT 'sending',
  connection_id UUID,
  provider_message_id TEXT,
  attempts JSONB NOT NULL DEFAULT '[]',
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  CONSTRAINT outbound_dispatches_pkey PRIMARY KEY (id),
  CONSTRAINT outbound_dispatches_channel_fkey FOREIGN KEY (workspace_id, channel_id) REFERENCES channels(workspace_id, id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT outbound_dispatches_kind_check CHECK (kind IN ('text','media','audio','contact','template')),
  CONSTRAINT outbound_dispatches_state_check CHECK (state IN ('sending','accepted','failed','uncertain','resolved_delivered','resolved_not_delivered')),
  CONSTRAINT outbound_dispatches_resolved_check CHECK ((state IN ('resolved_delivered','resolved_not_delivered')) = (resolved_at IS NOT NULL)),
  CONSTRAINT outbound_dispatches_preview_check CHECK (preview IS NULL OR char_length(preview) <= 160)
);
CREATE INDEX outbound_dispatches_scope_idx ON outbound_dispatches(workspace_id, channel_id, created_at DESC);
CREATE INDEX outbound_dispatches_open_idx ON outbound_dispatches(workspace_id, state, created_at) WHERE state IN ('sending','uncertain');
CREATE INDEX outbound_dispatches_provider_message_idx ON outbound_dispatches(workspace_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
