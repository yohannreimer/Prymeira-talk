import cors from "@fastify/cors";
import Fastify from "fastify";
import type { AppEnv } from "./env.js";

export interface CreateAppOptions {
  logger?: boolean;
}

export async function createApp(env: AppEnv, options: CreateAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true });

  await app.register(cors, {
    origin: env.CORS_ORIGINS.split(",").map((origin) => origin.trim())
  });

  app.get("/health", async () => ({ ok: true, product: env.PRYMEIRA_PRODUCT_KEY }));

  return app;
}
