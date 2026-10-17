-- Additive ownership evidence. Existing physical sessions are not silently claimed.
ALTER TABLE channels ADD COLUMN provider_instance_claim TEXT;

-- Historical media has a canonical observation/message but no HTTP receipt. Keep
-- receipt-backed obligations fenced by their original composite FK; permit only
-- anchored media obligations to omit both receipt coordinates together.
ALTER TABLE ingress_effects ALTER COLUMN receipt_id DROP NOT NULL;
ALTER TABLE ingress_effects ALTER COLUMN event_index DROP NOT NULL;
ALTER TABLE ingress_effects ADD CONSTRAINT ingress_effects_origin_check CHECK (
  (receipt_id IS NOT NULL AND event_index IS NOT NULL)
  OR (
    receipt_id IS NULL AND event_index IS NULL
    AND kind = 'media.prepare'
    AND COALESCE(cause->>'origin', '') = 'canonical_history'
    AND conversation_id IS NOT NULL AND message_id IS NOT NULL
  )
);
