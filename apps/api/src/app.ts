import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import type { AppEnv } from "./env.js";
import { authContextPlugin } from "./plugins/auth-context.js";
import type { AuthContextPluginOptions } from "./plugins/auth-context.js";
import { prismaPlugin } from "./plugins/prisma.js";
import { createAgentRuntime } from "./modules/agents/agent-runtime.js";
import { createAgentReplyScheduler } from "./modules/agents/agent-reply-scheduler.js";
import { agentsRoutes } from "./modules/agents/agents.routes.js";
import { createSimulatedAgentProvider } from "./modules/agents/provider-gateway.js";
import { automationsRoutes } from "./modules/automations/automations.routes.js";
import { assistantRoutes } from "./modules/assistant/assistant.routes.js";
import { createBoardRulesService, type BoardRulesPrismaLike } from "./modules/boards/board-rules.service.js";
import { boardsRoutes } from "./modules/boards/boards.routes.js";
import { campaignsRoutes } from "./modules/campaigns/campaigns.routes.js";
import { channelsRoutes } from "./modules/channels/channels.routes.js";
import { contactsRoutes } from "./modules/contacts/contacts.routes.js";
import { conversationsRoutes } from "./modules/conversations/conversations.routes.js";
import { createEvolutionRuntime } from "./modules/evolution/evolution-runtime.js";
import { crmRoutes } from "./modules/crm/crm.routes.js";
import { evolutionRoutes } from "./modules/evolution/evolution.routes.js";
import { metaWebhooksRoutes } from "./modules/meta/meta.webhooks.routes.js";
import { realtimeRoutes } from "./modules/realtime/realtime.routes.js";
import { reportsRoutes } from "./modules/reports/reports.routes.js";
import { settingsRoutes } from "./modules/settings/settings.routes.js";
import { tagsRoutes } from "./modules/tags/tags.routes.js";
import { teamRoutes } from "./modules/team/team.routes.js";
import { quickRepliesRoutes } from "./modules/quick-replies/quick-replies.routes.js";
import { uploadsRoutes } from "./modules/uploads/uploads.routes.js";

export interface CreateAppOptions {
  authEnabled?: boolean;
  fetch?: AuthContextPluginOptions["fetch"];
  logger?: boolean;
  prismaEnabled?: boolean;
  requireProductAccess?: AuthContextPluginOptions["requireProductAccess"];
}

export async function createApp(env: AppEnv, options: CreateAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true, trustProxy: true });
  const allowedCorsOrigins = env.CORS_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  await app.register(cors, {
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
    origin(origin, callback) {
      if (!origin || allowedCorsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(null, false);
    }
  });

  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_TIME_WINDOW,
    errorResponseBuilder(_request, context) {
      const error = new Error(`Too many requests. Try again in ${context.after}.`);
      (error as Error & { statusCode: number }).statusCode = context.statusCode;
      return error;
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    const maybeHttpError = error as Error & { statusCode?: number };
    if (maybeHttpError.statusCode === 429) {
      return reply.status(429).send({
        error: {
          code: "RATE_LIMITED",
          message: maybeHttpError.message
        }
      });
    }

    return reply.send(error);
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

  const evolutionRuntime = createEvolutionRuntime({
    mode: env.EVOLUTION_MODE,
    publicTalkUrl: env.PUBLIC_TALK_URL,
    localTalkUrl: env.LOCAL_TALK_URL,
    apiBaseUrl: env.EVOLUTION_API_BASE_URL,
    apiKey: env.EVOLUTION_API_KEY,
    webhookSecret: env.EVOLUTION_WEBHOOK_SECRET
  });
  const agentRuntime =
    options.prismaEnabled === false
      ? undefined
      : createAgentRuntime({
          prisma: app.prisma as unknown as Parameters<typeof createAgentRuntime>[0]["prisma"],
          provider: createSimulatedAgentProvider(),
          evolution: evolutionRuntime,
          realtime: app.realtime,
          boardRules: createBoardRulesService(app.prisma as unknown as BoardRulesPrismaLike)
        });
  const agentReplyScheduler =
    options.prismaEnabled === false || !agentRuntime
      ? undefined
      : createAgentReplyScheduler({
          prisma: app.prisma as unknown as Parameters<typeof createAgentReplyScheduler>[0]["prisma"],
          agentRuntime
        });
  agentReplyScheduler?.start();
  if (agentReplyScheduler) {
    app.addHook("onClose", async () => {
      agentReplyScheduler.stop();
    });
  }

  await app.register(evolutionRoutes, {
    webhookSecret: env.EVOLUTION_WEBHOOK_SECRET,
    agentRuntime,
    agentReplyScheduler,
    evolution: evolutionRuntime
  });
  await app.register(metaWebhooksRoutes);
  await app.register(conversationsRoutes, { evolution: evolutionRuntime });
  await app.register(quickRepliesRoutes);
  await app.register(uploadsRoutes, {
    publicTalkUrl: env.PUBLIC_TALK_URL,
    uploadDir: env.TALK_UPLOAD_DIR
  });
  await app.register(contactsRoutes);
  await app.register(boardsRoutes);
  await app.register(channelsRoutes, { evolution: evolutionRuntime });
  await app.register(automationsRoutes, { agentRuntime, evolution: evolutionRuntime });
  await app.register(campaignsRoutes, { evolution: evolutionRuntime });
  await app.register(reportsRoutes);
  await app.register(teamRoutes);
  await app.register(tagsRoutes);
  await app.register(agentsRoutes);
  await app.register(assistantRoutes);
  await app.register(crmRoutes, {
    vinculaApiUrl: env.VINCULA_CRM_API_URL
  });
  await app.register(settingsRoutes);

  return app;
}
