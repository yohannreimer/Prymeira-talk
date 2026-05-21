import cors from "@fastify/cors";
import Fastify from "fastify";
import type { AppEnv } from "./env.js";
import { authContextPlugin } from "./plugins/auth-context.js";
import type { AuthContextPluginOptions } from "./plugins/auth-context.js";
import { prismaPlugin } from "./plugins/prisma.js";
import { boardsRoutes } from "./modules/boards/boards.routes.js";
import { contactsRoutes } from "./modules/contacts/contacts.routes.js";
import { conversationsRoutes } from "./modules/conversations/conversations.routes.js";
import { evolutionRoutes } from "./modules/evolution/evolution.routes.js";
import { realtimeRoutes } from "./modules/realtime/realtime.routes.js";

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
  await app.register(realtimeRoutes);
  await app.register(evolutionRoutes, { webhookSecret: env.EVOLUTION_WEBHOOK_SECRET });
  await app.register(conversationsRoutes);
  await app.register(contactsRoutes);
  await app.register(boardsRoutes);

  return app;
}
