ALTER TABLE canonical_addresses ADD COLUMN state TEXT NOT NULL DEFAULT 'active', ADD COLUMN review_reason TEXT;
ALTER TABLE canonical_addresses ADD CONSTRAINT canonical_address_review_state CHECK (state IN ('active','review'));
