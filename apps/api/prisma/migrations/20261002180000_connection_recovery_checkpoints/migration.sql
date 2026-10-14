-- Persistent gap-recovery checkpoint and complementary-history marker per physical connection. Additive.
ALTER TABLE channel_connections ADD COLUMN recovered_through_at TIMESTAMP(3);
ALTER TABLE channel_connections ADD COLUMN history_imported_at TIMESTAMP(3);
