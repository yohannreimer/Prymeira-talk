-- Separate operation tokens keep the two providers independent while channel generation fences probes.
ALTER TABLE "channel_connections" ADD COLUMN "lifecycle_generation" INTEGER NOT NULL DEFAULT 0;
