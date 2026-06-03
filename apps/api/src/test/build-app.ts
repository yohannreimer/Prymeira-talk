import { createApp } from "../app.js";
import type { CreateAppOptions } from "../app.js";
import type { AppEnv } from "../env.js";

export async function buildApp(
  overrides: Partial<AppEnv> = {},
  options: CreateAppOptions = {}
) {
  return createApp(
    {
      API_HOST: "127.0.0.1",
      API_PORT: 0,
      CORS_ORIGINS: "http://localhost:5176",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:54329/prymeira_talk",
      PRYMEIRA_ACCOUNT_API_URL: "http://localhost:3001",
      PRYMEIRA_LOCAL_AUTH_BYPASS: false,
      PRYMEIRA_LOCAL_WORKSPACE_ID: "local_workspace",
      PRYMEIRA_LOCAL_ROLE: "owner",
      PRYMEIRA_PRODUCT_KEY: "talk",
      CLERK_SECRET_KEY: "sk_test_replace_me",
      PUBLIC_TALK_URL: "https://talk.prymeiradigital.com.br",
      LOCAL_TALK_URL: "http://localhost:3002",
      EVOLUTION_MODE: "simulated",
      EVOLUTION_WEBHOOK_SECRET: "test_secret",
      TALK_UPLOAD_DIR: "tmp/test-uploads",
      ...overrides
    },
    { authEnabled: false, logger: false, prismaEnabled: false, ...options }
  );
}
