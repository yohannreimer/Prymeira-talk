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
  it('needs the HMAC key whenever WAHA is told where Talk\'s ingress is', () => {
    expect(readEnv(baseProductionEnv).WAHA_WEBHOOK_BASE_URL).toBeUndefined();
    expect(readEnv(baseProductionEnv).WAHA_WEBHOOK_HMAC_KEY).toBeUndefined();
    expect(() => readEnv({ ...baseProductionEnv, WAHA_WEBHOOK_BASE_URL: 'http://ingress:4011' })).toThrow(/WAHA_WEBHOOK_HMAC_KEY/);
    expect(() => readEnv({ ...baseProductionEnv, WAHA_WEBHOOK_BASE_URL: 'http://ingress:4011', WAHA_WEBHOOK_HMAC_KEY: 'short' })).toThrow();
    expect(readEnv({ ...baseProductionEnv, WAHA_WEBHOOK_BASE_URL: 'http://ingress:4011', WAHA_WEBHOOK_HMAC_KEY: 'shared-hmac-key-1234567' })).toMatchObject({ WAHA_WEBHOOK_BASE_URL: 'http://ingress:4011' });
  });
  it('runs durable effects only with the realtime bridge, and scopes them to an allowlist when given', () => {
    expect(readEnv(baseProductionEnv)).toMatchObject({ EFFECTS_ENABLED: false, REALTIME_BRIDGE_ENABLED: false, EFFECTS_WORKSPACE_ALLOWLIST: [] });
    expect(() => readEnv({ ...baseProductionEnv, EFFECTS_ENABLED: 'true' })).toThrow(/REALTIME_BRIDGE_ENABLED/);
    expect(readEnv({ ...baseProductionEnv, EFFECTS_ENABLED: 'true', REALTIME_BRIDGE_ENABLED: 'true', EFFECTS_WORKSPACE_ALLOWLIST: ' a, b ,' })).toMatchObject({ EFFECTS_ENABLED: true, EFFECTS_WORKSPACE_ALLOWLIST: ['a', 'b'] });
  });
  it('keeps durable media off unless an absolute private store path is configured', () => {
    expect(readEnv(baseProductionEnv).TALK_MEDIA_STORE_PATH).toBeUndefined();
    expect(readEnv({ ...baseProductionEnv, TALK_MEDIA_STORE_PATH: '/var/lib/talk/media' }).TALK_MEDIA_STORE_PATH).toBe('/var/lib/talk/media');
    expect(() => readEnv({ ...baseProductionEnv, TALK_MEDIA_STORE_PATH: 'relative/media' })).toThrow(/TALK_MEDIA_STORE_PATH/);
  });
  it('keeps WAHA disabled until qualification and validates enabled runtime credentials', () => {
    expect(readEnv(baseProductionEnv).WAHA_ENABLED).toBe(false);
    expect(() => readEnv({ ...baseProductionEnv, WAHA_ENABLED: 'true' })).toThrow(/WAHA/);
    expect(() => readEnv({ ...baseProductionEnv, WAHA_ENABLED: 'true', WAHA_API_BASE_URL: 'ftp://waha.example', WAHA_API_KEY: 'secret' })).toThrow(/WAHA/);
    expect(() => readEnv({ ...baseProductionEnv, WAHA_API_BASE_URL: 'invalid-url' })).toThrow(/WAHA/);
    expect(() => readEnv({ ...baseProductionEnv, WAHA_API_BASE_URL: 'https://user:pass@waha.example' })).toThrow(/WAHA/);
    expect(readEnv({ ...baseProductionEnv, WAHA_ENABLED: 'true', WAHA_API_BASE_URL: 'https://waha.example', WAHA_API_KEY: 'secret' }).WAHA_ENABLED).toBe(true);
  });
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

  it("selects the inbox triage model from a validated setting", () => {
    expect(readEnv(baseProductionEnv).INBOX_TRIAGE_PRIMARY).toBe("jev");
    expect(readEnv(baseProductionEnv).INBOX_TRIAGE_ENABLED).toBe(false);
    expect(readEnv({ ...baseProductionEnv, INBOX_TRIAGE_PRIMARY: "jev" }).INBOX_TRIAGE_PRIMARY).toBe("jev");
    expect(readEnv({ ...baseProductionEnv, INBOX_TRIAGE_ENABLED: "true" }).INBOX_TRIAGE_ENABLED).toBe(true);
    expect(() => readEnv({ ...baseProductionEnv, INBOX_TRIAGE_PRIMARY: "unknown" })).toThrow(/INBOX_TRIAGE_PRIMARY/);
  });

  it("loads the conservative Leads defaults without source services", () => {
    const env = readEnv(baseProductionEnv);

    expect(env).toMatchObject({
      LEAD_GOOGLE_MAX_CONCURRENT_JOBS: 1,
      LEAD_GOOGLE_DEFAULT_DEPTH: 12,
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
        LEAD_GOOGLE_DEFAULT_DEPTH: "21"
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

    expect(() => readEnv({ ...baseProductionEnv, LEAD_JOB_POLL_MS: "999" }))
      .toThrow(/LEAD_JOB_POLL_MS/);
    expect(() => readEnv({ ...baseProductionEnv, LEAD_JOB_POLL_MS: "60001" }))
      .toThrow(/LEAD_JOB_POLL_MS/);
  });

  it("keeps canonical history import off unless explicitly enabled", () => {
    expect(readEnv({ ...baseProductionEnv }).CANONICAL_HISTORY_IMPORT_ENABLED).toBe(false);
    expect(readEnv({ ...baseProductionEnv, CANONICAL_HISTORY_IMPORT_ENABLED: "true" }).CANONICAL_HISTORY_IMPORT_ENABLED).toBe(true);
  });

  it("parses the delegated legacy-webhook workspaces", () => {
    expect(readEnv({ ...baseProductionEnv }).LEGACY_WEBHOOK_DELEGATED_WORKSPACES).toEqual(new Set());
    expect(readEnv({ ...baseProductionEnv, LEGACY_WEBHOOK_DELEGATED_WORKSPACES: " a , b ,," }).LEGACY_WEBHOOK_DELEGATED_WORKSPACES).toEqual(new Set(["a", "b"]));
    expect(readEnv({ ...baseProductionEnv, LEGACY_WEBHOOK_DELEGATED_WORKSPACES: "*" }).LEGACY_WEBHOOK_DELEGATED_WORKSPACES).toBe("*");
  });

  it("treats an empty TALK_MEDIA_STORE_PATH (compose default) as unset but still rejects a relative one", () => {
    expect(readEnv({ ...baseProductionEnv, TALK_MEDIA_STORE_PATH: "" }).TALK_MEDIA_STORE_PATH).toBeUndefined();
    expect(readEnv({ ...baseProductionEnv, TALK_MEDIA_STORE_PATH: "/data/media" }).TALK_MEDIA_STORE_PATH).toBe("/data/media");
    expect(() => readEnv({ ...baseProductionEnv, TALK_MEDIA_STORE_PATH: "media" })).toThrow();
  });

  it("starts with exactly the docker-compose defaults (every new switch empty or false)", () => {
    const composeDefaults = { WAHA_ENABLED: "false", WAHA_API_BASE_URL: "", WAHA_API_KEY: "", WAHA_WEBHOOK_BASE_URL: "", WAHA_WEBHOOK_HMAC_KEY: "",
      OUTBOUND_ROUTER_ENABLED: "false", CHANNEL_HEALTH_MONITOR_ENABLED: "false", CANONICAL_HISTORY_IMPORT_ENABLED: "false", LEGACY_WEBHOOK_DELEGATED_WORKSPACES: "",
      EFFECTS_ENABLED: "false", EFFECTS_WORKSPACE_ALLOWLIST: "", REALTIME_BRIDGE_ENABLED: "false", TALK_MEDIA_STORE_PATH: "" };
    const env = readEnv({ ...baseProductionEnv, ...composeDefaults });
    expect(env).toMatchObject({ WAHA_ENABLED: false, OUTBOUND_ROUTER_ENABLED: false, EFFECTS_ENABLED: false, CANONICAL_HISTORY_IMPORT_ENABLED: false });
    expect(env.WAHA_WEBHOOK_HMAC_KEY).toBeUndefined();
    expect(env.TALK_MEDIA_STORE_PATH).toBeUndefined();
    expect(() => readEnv({ ...baseProductionEnv, WAHA_WEBHOOK_HMAC_KEY: "short" })).toThrow();
  });
});
