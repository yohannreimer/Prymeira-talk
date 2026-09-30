-- Persistently fence provider observations across QR, logout and redundancy changes.
ALTER TABLE "channels" ADD COLUMN "connection_lifecycle_generation" INTEGER NOT NULL DEFAULT 0;
