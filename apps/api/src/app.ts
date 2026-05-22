import cors from "@fastify/cors";
import Fastify from "fastify";
import type { AppEnv } from "./env.js";
import { authContextPlugin } from "./plugins/auth-context.js";
import type { AuthContextPluginOptions } from "./plugins/auth-context.js";
import { prismaPlugin } from "./plugins/prisma.js";
import { automationsRoutes } from "./modules/automations/automations.routes.js";
import { assistantRoutes } from "./modules/assistant/assistant.routes.js";
import { boardsRoutes } from "./modules/boards/boards.routes.js";
import { campaignsRoutes } from "./modules/campaigns/campaigns.routes.js";
import { channelsRoutes } from "./modules/channels/channels.routes.js";
import { contactsRoutes } from "./modules/contacts/contacts.routes.js";
import { conversationsRoutes } from "./modules/conversations/conversations.routes.js";
import { createEvolutionRuntime } from "./modules/evolution/evolution-runtime.js";
import { crmRoutes } from "./modules/crm/crm.routes.js";
import { evolutionRoutes } from "./modules/evolution/evolution.routes.js";
import { realtimeRoutes } from "./modules/realtime/realtime.routes.js";
import { reportsRoutes } from "./modules/reports/reports.routes.js";
import { settingsRoutes } from "./modules/settings/settings.routes.js";
import { teamRoutes } from "./modules/team/team.routes.js";

export interface CreateAppOptions {
  authEnabled?: boolean;
  fetch?: AuthContextPluginOptions["fetch"];
  logger?: boolean;
  prismaEnabled?: boolean;
  requireProductAccess?: AuthContextPluginOptions["requireProductAccess"];
}

export async function createApp(env: AppEnv, options: CreateAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true });

  await app.register(cors, {
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
    origin: env.CORS_ORIGINS.split(",").map((origin) => origin.trim())
  });

  if (options.prismaEnabled !== false) {
    await app.register(prismaPlugin, { databaseUrl: env.DATABASE_URL });
  }

  if (options.authEnabled !== false) {
    await app.register(authContextPlugin, {
      accountApiUrl: env.PRYMEIRA_ACCOUNT_API_URL,
      productKey: env.PRYMEIRA_PRODUCT_KEY,
      localAuthBypass: env.PRYMEIRA_LOCAL_AUTH_BYPASS
        ? {
            workspaceId: env.PRYMEIRA_LOCAL_WORKSPACE_ID,
            role: env.PRYMEIRA_LOCAL_ROLE
          }
        : undefined,
      fetch: options.fetch,
      requireProductAccess: options.requireProductAccess
    });
  }

  app.get("/health", async () => ({ ok: true, product: env.PRYMEIRA_PRODUCT_KEY }));
  app.get("/me", async (request) => ({
    workspaceId: request.talk.workspaceId,
    role: request.talk.role
  }));

  const evolutionRuntime = createEvolutionRuntime({
    mode: env.EVOLUTION_MODE,
    publicTalkUrl: env.PUBLIC_TALK_URL,
    localTalkUrl: env.LOCAL_TALK_URL,
    apiBaseUrl: env.EVOLUTION_API_BASE_URL,
    apiKey: env.EVOLUTION_API_KEY,
    webhookSecret: env.EVOLUTION_WEBHOOK_SECRET
  });

  await app.register(realtimeRoutes);
  await app.register(evolutionRoutes, { webhookSecret: env.EVOLUTION_WEBHOOK_SECRET });
  await app.register(conversationsRoutes, { evolution: evolutionRuntime });
  await app.register(contactsRoutes);
  await app.register(boardsRoutes);
  await app.register(channelsRoutes, { evolution: evolutionRuntime });
  await app.register(automationsRoutes);
  await app.register(campaignsRoutes);
  await app.register(reportsRoutes);
  await app.register(teamRoutes);
  await app.register(assistantRoutes);
  await app.register(crmRoutes);
  await app.register(settingsRoutes);

  return app;
}
