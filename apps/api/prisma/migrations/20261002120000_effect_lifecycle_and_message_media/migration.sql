-- Additive. Effect rows were pure obligations; handlers now need an explicit lifecycle.
ALTER TABLE ingress_effects
  ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN locked_by TEXT,
  ADD COLUMN lease_until TIMESTAMPTZ,
  ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN last_error_code TEXT,
  ADD COLUMN completed_at TIMESTAMPTZ,
  ADD COLUMN result JSONB;
-- Stage 1B pinned every effect to 'pending' (no handlers existed); the lifecycle check below replaces it.
ALTER TABLE ingress_effects DROP CONSTRAINT ingress_effect_pending;
ALTER TABLE ingress_effects
  ADD CONSTRAINT ingress_effects_state_check CHECK (state IN ('pending','running','done','failed')),
  ADD CONSTRAINT ingress_effects_attempts_check CHECK (attempts >= 0),
  ADD CONSTRAINT ingress_effects_running_lease_check CHECK (state <> 'running' OR (locked_by IS NOT NULL AND lease_until IS NOT NULL)),
  ADD CONSTRAINT ingress_effects_done_check CHECK ((state IN ('done','failed')) = (completed_at IS NOT NULL));
CREATE INDEX ingress_effects_claim_idx ON ingress_effects(state, next_attempt_at, created_at);

-- One prepared attachment per message. Bytes live in the private media store, never here.
CREATE TABLE message_media (
  message_id UUID NOT NULL,
  workspace_id TEXT NOT NULL,
  conversation_id UUID NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  source_kind TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  original_ref TEXT,
  playback_ref TEXT,
  playback_mime_type TEXT,
  playback_sha256 TEXT,
  error_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT message_media_pkey PRIMARY KEY(message_id),
  CONSTRAINT message_media_scope_key UNIQUE(workspace_id,conversation_id,message_id),
  CONSTRAINT message_media_message_fkey FOREIGN KEY(workspace_id,conversation_id,message_id)
    REFERENCES messages(workspace_id,conversation_id,id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT message_media_state_check CHECK (state IN ('pending','stored','failed','limit_exceeded','unavailable')),
  CONSTRAINT message_media_stored_check CHECK (state <> 'stored' OR (original_ref IS NOT NULL AND sha256 ~ '^[0-9a-f]{64}$' AND mime_type IS NOT NULL AND size_bytes IS NOT NULL AND size_bytes >= 0)),
  CONSTRAINT message_media_playback_check CHECK ((playback_ref IS NULL) = (playback_sha256 IS NULL)),
  CONSTRAINT message_media_attempts_check CHECK (attempts >= 0)
);
CREATE INDEX message_media_scope_idx ON message_media(workspace_id,conversation_id,state);

-- Effects stay immutable obligations (identity, cause and frozen inputs), but handlers need to move
-- the lifecycle columns. A completed effect is final; only an operator requeue may leave 'failed'.
DROP TRIGGER ingress_effect_immutable ON ingress_effects;
CREATE FUNCTION ingress_effect_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.workspace_id, NEW.channel_id, NEW.receipt_id, NEW.event_index, NEW.conversation_id, NEW.message_id, NEW.kind, NEW.logical_key, NEW.cause, NEW.frozen, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.workspace_id, OLD.channel_id, OLD.receipt_id, OLD.event_index, OLD.conversation_id, OLD.message_id, OLD.kind, OLD.logical_key, OLD.cause, OLD.frozen, OLD.created_at) THEN
    RAISE EXCEPTION 'immutable ingress fact';
  END IF;
  IF OLD.state = 'done' THEN RAISE EXCEPTION 'completed ingress effect is final'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ingress_effect_guard BEFORE UPDATE ON ingress_effects FOR EACH ROW EXECUTE FUNCTION ingress_effect_guard();
