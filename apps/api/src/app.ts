import cors from "@fastify/cors";
import Fastify from "fastify";
import type { AppEnv } from "./env.js";

export async function createApp(env: AppEnv) {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: env.CORS_ORIGINS.split(",").map((origin) => origin.trim())
  });

  app.get("/health", async () => ({ ok: true, product: env.PRYMEIRA_PRODUCT_KEY }));

  return app;
}
