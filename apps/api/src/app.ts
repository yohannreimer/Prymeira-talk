import cors from "@fastify/cors";
import Fastify from "fastify";
import type { AppEnv } from "./env.js";
import { authContextPlugin } from "./plugins/auth-context.js";
import type { AuthContextPluginOptions } from "./plugins/auth-context.js";

export interface CreateAppOptions {
  authEnabled?: boolean;
  fetch?: AuthContextPluginOptions["fetch"];
  logger?: boolean;
  requireProductAccess?: AuthContextPluginOptions["requireProductAccess"];
}

export async function createApp(env: AppEnv, options: CreateAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true });

  await app.register(cors, {
    origin: env.CORS_ORIGINS.split(",").map((origin) => origin.trim())
  });

  if (options.authEnabled !== false) {
    await app.register(authContextPlugin, {
      accountApiUrl: env.PRYMEIRA_ACCOUNT_API_URL,
      productKey: env.PRYMEIRA_PRODUCT_KEY,
      fetch: options.fetch,
      requireProductAccess: options.requireProductAccess
    });
  }

  app.get("/health", async () => ({ ok: true, product: env.PRYMEIRA_PRODUCT_KEY }));
  app.get("/me", async (request) => ({
    workspaceId: request.talk.workspaceId,
    role: request.talk.role
  }));

  return app;
}
