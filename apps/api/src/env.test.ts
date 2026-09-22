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
      RATE_LIMIT_TIME_WINDOW: "1 minute"
    });
  });

  it("loads optional JEV reply-preflight settings", () => {
    expect(readEnv({
      ...baseProductionEnv,
      JEV_API_KEY: "jev-secret",
      JEV_MODEL: "jev-1.13"
    })).toMatchObject({
      JEV_API_KEY: "jev-secret",
      JEV_MODEL: "jev-1.13"
    });
  });

  it("loads the conservative Leads defaults without source services", () => {
    const env = readEnv(baseProductionEnv);

    expect(env).toMatchObject({
      LEAD_GOOGLE_MAX_CONCURRENT_JOBS: 1,
      LEAD_GOOGLE_DEFAULT_DEPTH: 5,
      LEAD_WHATSAPP_BATCH_SIZE: 25
    });
    expect(env.CNPJ_DATABASE_URL).toBeUndefined();
    expect(env.GOOGLE_MAPS_SCRAPER_URL).toBeUndefined();
    expect(env.LEAD_JOB_POLL_MS).toBeUndefined();
  });

  it("validates optional Leads source URLs and execution limits", () => {
    expect(readEnv({
      ...baseProductionEnv,
      CNPJ_DATABASE_URL: "postgresql://reader:password@cnpj.internal/cnpj",
      GOOGLE_MAPS_SCRAPER_URL: "https://scraper.internal"
    })).toMatchObject({
      CNPJ_DATABASE_URL: "postgresql://reader:password@cnpj.internal/cnpj",
      GOOGLE_MAPS_SCRAPER_URL: "https://scraper.internal"
    });

    expect(() =>
      readEnv({
        ...baseProductionEnv,
        CNPJ_DATABASE_URL: "not-a-database-url"
      })
    ).toThrow(/CNPJ_DATABASE_URL/);

    expect(() =>
      readEnv({
        ...baseProductionEnv,
        CNPJ_DATABASE_URL: "mysql://reader:password@cnpj.internal/cnpj"
      })
    ).toThrow(/CNPJ_DATABASE_URL/);

    expect(() =>
      readEnv({
        ...baseProductionEnv,
        GOOGLE_MAPS_SCRAPER_URL: "not-a-url"
      })
    ).toThrow(/GOOGLE_MAPS_SCRAPER_URL/);

    expect(() =>
      readEnv({
        ...baseProductionEnv,
        GOOGLE_MAPS_SCRAPER_URL: "ftp://scraper.internal"
      })
    ).toThrow(/GOOGLE_MAPS_SCRAPER_URL/);

    expect(() =>
      readEnv({
        ...baseProductionEnv,
        LEAD_GOOGLE_MAX_CONCURRENT_JOBS: "0"
      })
    ).toThrow(/LEAD_GOOGLE_MAX_CONCURRENT_JOBS/);

    expect(() =>
      readEnv({
        ...baseProductionEnv,
        LEAD_GOOGLE_DEFAULT_DEPTH: "6"
      })
    ).toThrow(/LEAD_GOOGLE_DEFAULT_DEPTH/);

    expect(() =>
      readEnv({
        ...baseProductionEnv,
        LEAD_WHATSAPP_BATCH_SIZE: "26"
      })
    ).toThrow(/LEAD_WHATSAPP_BATCH_SIZE/);

    expect(() =>
      readEnv({
        ...baseProductionEnv,
        LEAD_JOB_POLL_MS: "0"
      })
    ).toThrow(/LEAD_JOB_POLL_MS/);
  });
});
