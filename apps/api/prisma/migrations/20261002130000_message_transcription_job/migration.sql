-- One persistent transcription job per audio message, shared by the automatic path, the manual
-- button and the assistant. The text itself stays in messages.body (existing readers rely on it).
ALTER TABLE message_media
  ADD COLUMN transcription_state TEXT,
  ADD COLUMN transcription_token UUID,
  ADD COLUMN transcription_lease_until TIMESTAMPTZ,
  ADD COLUMN transcription_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN transcription_error_code TEXT,
  ADD COLUMN transcribed_at TIMESTAMPTZ;
ALTER TABLE message_media
  ADD CONSTRAINT message_media_transcription_state_check CHECK (transcription_state IS NULL OR transcription_state IN ('running','completed','failed')),
  ADD CONSTRAINT message_media_transcription_lease_check CHECK (transcription_state IS DISTINCT FROM 'running' OR (transcription_token IS NOT NULL AND transcription_lease_until IS NOT NULL)),
  ADD CONSTRAINT message_media_transcription_done_check CHECK ((transcription_state = 'completed') = (transcribed_at IS NOT NULL));
