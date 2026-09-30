CREATE TYPE "ChannelConnectionProvider" AS ENUM ('evolution', 'waha');
CREATE TYPE "ChannelConnectionHealth" AS ENUM ('unknown', 'healthy', 'degraded', 'unhealthy');

ALTER TABLE "channels" ADD COLUMN "redundancy_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "active_connection_id" UUID;

CREATE TABLE "channel_connections" (
  "id" UUID NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "channel_id" UUID NOT NULL,
  "provider" "ChannelConnectionProvider" NOT NULL,
  "session_name" TEXT NOT NULL,
  "status" "ChannelStatus" NOT NULL DEFAULT 'disconnected',
  "health" "ChannelConnectionHealth" NOT NULL DEFAULT 'unknown',
  "verified_phone_number" TEXT,
  "eligible" BOOLEAN NOT NULL DEFAULT false,
  "last_checked_at" TIMESTAMP(3),
  "last_healthy_at" TIMESTAMP(3),
  "failure_started_at" TIMESTAMP(3),
  "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "connected_at" TIMESTAMP(3),
  "disconnected_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "channel_connections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "channel_connections_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "channel_connections_workspace_id_id_key" ON "channel_connections"("workspace_id", "id");
CREATE UNIQUE INDEX "channel_connections_workspace_id_channel_id_provider_key" ON "channel_connections"("workspace_id", "channel_id", "provider");
CREATE UNIQUE INDEX "channel_connections_workspace_id_provider_session_name_key" ON "channel_connections"("workspace_id", "provider", "session_name");
-- WAHA session names are global within the configured server. Legacy Evolution keys remain tenant scoped.
CREATE UNIQUE INDEX "channel_connections_waha_session_name_key" ON "channel_connections"("session_name") WHERE "provider" = 'waha';
CREATE INDEX "channel_connections_status_health_last_checked_at_idx" ON "channel_connections"("status", "health", "last_checked_at");

-- Add physical identities without changing logical IDs, providers, phone numbers, history or settings.
-- An existing channel phone is display data; actual provider identity must still be verified.
INSERT INTO "channel_connections" ("id", "workspace_id", "channel_id", "provider", "session_name", "status", "eligible", "created_at", "updated_at")
SELECT md5('talk-evolution:' || "workspace_id" || ':' || "id"::text)::uuid,
  "workspace_id", "id", 'evolution', "provider_key", "status", "status" = 'connected', "created_at", "updated_at"
FROM "channels" WHERE "provider" = 'evolution';

UPDATE "channels" c SET "active_connection_id" = p."id"
FROM "channel_connections" p WHERE p."workspace_id" = c."workspace_id" AND p."channel_id" = c."id" AND p."provider" = 'evolution';
