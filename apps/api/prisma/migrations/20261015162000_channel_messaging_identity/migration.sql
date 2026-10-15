-- A first authenticated WAHA session can establish the logical channel's phone
-- identity without claiming that an absent Evolution session has been verified.
-- Existing rows remain unclaimed until a trusted current-generation probe.
ALTER TABLE channels ADD COLUMN verified_messaging_phone_number TEXT;
