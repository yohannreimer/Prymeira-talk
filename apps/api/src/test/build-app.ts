import { createApp } from "../app.js";
import type { AppEnv } from "../env.js";

export async function buildApp(
  overrides: Partial<AppEnv> = {},
  options: { authEnabled?: boolean; logger?: boolean } = {}
) {
  return createApp(
    {
      API_HOST: "127.0.0.1",
      API_PORT: 0,
      CORS_ORIGINS: "http://localhost:5176",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:54329/prymeira_talk",
      PRYMEIRA_ACCOUNT_API_URL: "http://localhost:3001",
      PRYMEIRA_PRODUCT_KEY: "talk",
      CLERK_SECRET_KEY: "sk_test_replace_me",
      EVOLUTION_WEBHOOK_SECRET: "test_secret",
      ...overrides
    },
    { authEnabled: false, logger: false, ...options }
  );
}
