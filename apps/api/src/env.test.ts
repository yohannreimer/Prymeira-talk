import { describe, expect, it } from "vitest";
import { readEnv } from "./env.js";

const baseProductionEnv = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:54329/prymeira_talk",
  CORS_ORIGINS: "https://talk.prymeiradigital.com.br",
  PRYMEIRA_ACCOUNT_API_URL: "https://hub.prymeiradigital.com.br/api",
  PRYMEIRA_LOCAL_AUTH_BYPASS: "false",
  PRYMEIRA_PRODUCT_KEY: "talk",
  CLERK_SECRET_KEY: "sk_live_replace_me",
  EVOLUTION_WEBHOOK_SECRET: "webhook_secret"
} as const;

describe("readEnv", () => {
  it("rejects local auth bypass in production", () => {
    expect(() =>
      readEnv({
        ...baseProductionEnv,
        PRYMEIRA_LOCAL_AUTH_BYPASS: "true"
      })
    ).toThrow(/PRYMEIRA_LOCAL_AUTH_BYPASS/);
  });

  it("rejects production without configured CORS origins", () => {
    expect(() =>
      readEnv({
        ...baseProductionEnv,
        CORS_ORIGINS: ""
      })
    ).toThrow(/CORS_ORIGINS/);
  });

  it("loads rate-limit defaults", () => {
    expect(readEnv(baseProductionEnv)).toMatchObject({
      RATE_LIMIT_MAX: 300,
      RATE_LIMIT_TIME_WINDOW: "1 minute",
      PRYMEIRA_LOCAL_DEMO_ENABLED: false
    });
  });

  it("rejects local demo mode in production", () => {
    expect(() =>
      readEnv({
        ...baseProductionEnv,
        PRYMEIRA_LOCAL_DEMO_ENABLED: "true"
      })
    ).toThrow(/PRYMEIRA_LOCAL_DEMO_ENABLED/);
  });

  it("loads server-only Vincula integration settings", () => {
    expect(
      readEnv({
        ...baseProductionEnv,
        NODE_ENV: "development",
        PRYMEIRA_LOCAL_DEMO_ENABLED: "true",
        VINCULA_CRM_API_URL: "http://localhost:3003/api",
        VINCULA_CRM_API_TOKEN: "server-token",
        VINCULA_CRM_WEB_URL: "http://localhost:5174",
        VINCULA_CRM_STRICT_REAL: "true",
        VINCULA_CRM_RESET_URL: "http://localhost:3003/api/demo/reset",
        VINCULA_CRM_RESET_TOKEN: "reset-token"
      })
    ).toMatchObject({
      VINCULA_CRM_API_TOKEN: "server-token",
      VINCULA_CRM_WEB_URL: "http://localhost:5174",
      VINCULA_CRM_STRICT_REAL: true,
      VINCULA_CRM_RESET_URL: "http://localhost:3003/api/demo/reset",
      VINCULA_CRM_RESET_TOKEN: "reset-token"
    });
  });
});
