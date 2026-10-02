import { z } from "zod";

const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional()
);

const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().url().optional()
);

function optionalUrlWithProtocols(protocols: readonly string[]) {
  return z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z
      .string()
      .url()
      .refine(
        (value) => {
          try {
            return protocols.includes(new URL(value).protocol);
          } catch {
            return false;
          }
        },
        { message: `URL protocol must be one of: ${protocols.join(", ")}` }
      )
      .optional()
  );
}

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    API_HOST: z.string().default("0.0.0.0"),
    API_PORT: z.coerce.number().int().positive().default(3002),
    CORS_ORIGINS: z.string().default("http://localhost:5176"),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
    RATE_LIMIT_TIME_WINDOW: z.string().min(1).default("1 minute"),
    DATABASE_URL: z.string().min(1),
    PRYMEIRA_ACCOUNT_API_URL: z.string().url(),
    PRYMEIRA_LOCAL_AUTH_BYPASS: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    PRYMEIRA_LOCAL_WORKSPACE_ID: z.string().min(1).default("local_workspace"),
    PRYMEIRA_LOCAL_ROLE: z.enum(["owner", "manager", "agent"]).default("owner"),
    PRYMEIRA_PRODUCT_KEY: z.string().default("talk"),
    CLERK_SECRET_KEY: z.string().min(1),
    PUBLIC_TALK_URL: z.string().url().default("https://talk.prymeiradigital.com.br"),
    LOCAL_TALK_URL: z.string().url().default("http://localhost:3002"),
    EVOLUTION_MODE: z.enum(["simulated", "real"]).default("simulated"),
    EVOLUTION_API_BASE_URL: optionalUrl,
    EVOLUTION_API_KEY: optionalNonEmptyString,
    EVOLUTION_WEBHOOK_SECRET: z.string().min(1),
    WAHA_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
    WAHA_API_BASE_URL: optionalUrlWithProtocols(['http:', 'https:']),
    WAHA_API_KEY: optionalNonEmptyString,
    JEV_API_KEY: optionalNonEmptyString,
    JEV_MODEL: z.string().min(1).default("jev-latest"),
    INBOX_TRIAGE_PRIMARY: z.enum(["luna", "jev"]).default("jev"),
    INBOX_TRIAGE_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
    TALK_UPLOAD_DIR: z.string().min(1).default("storage/uploads"),
    /** Runs the durable ingress effects (assistant, agent, follow-ups, triage, automations, realtime) in this API process. */
    EFFECTS_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
    /** Comma-separated workspace ids whose effects this process may run (staged rollout). Empty = all. */
    EFFECTS_WORKSPACE_ALLOWLIST: z.string().default('').transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean)),
    /** Fan realtime events out across API processes (PostgreSQL LISTEN/NOTIFY). Off keeps one-process behaviour. */
    REALTIME_BRIDGE_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
    /** Absolute private directory for durable message media. Unset keeps the legacy media path. */
    TALK_MEDIA_STORE_PATH: z.string().min(1).refine((value) => value.startsWith('/'), 'TALK_MEDIA_STORE_PATH must be an absolute path').optional(),
    VINCULA_CRM_API_URL: optionalUrl,
    CNPJ_DATABASE_URL: optionalUrlWithProtocols(["postgres:", "postgresql:"]),
    GOOGLE_MAPS_SCRAPER_URL: optionalUrlWithProtocols(["http:", "https:"]),
    LEAD_GOOGLE_MAX_CONCURRENT_JOBS: z.coerce.number().int().positive().default(1),
    LEAD_GOOGLE_DEFAULT_DEPTH: z.coerce.number().int().positive().max(20).default(12),
    LEAD_WHATSAPP_BATCH_SIZE: z.coerce.number().int().positive().max(25).default(25),
    LEAD_JOB_POLL_MS: z.coerce.number().int().min(1_000).max(60_000).optional()
  })
  .superRefine((env, ctx) => {
    if (env.EFFECTS_ENABLED && !env.REALTIME_BRIDGE_ENABLED) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['EFFECTS_ENABLED'], message: 'EFFECTS_ENABLED requires REALTIME_BRIDGE_ENABLED=true: connection and QR events are published by the ingress worker.' });
    }
    if (env.WAHA_ENABLED && (!env.WAHA_API_BASE_URL || !env.WAHA_API_KEY)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['WAHA_ENABLED'], message: 'Enabled WAHA requires WAHA_API_BASE_URL and WAHA_API_KEY.' });
    }
    if (env.WAHA_API_BASE_URL) {
      try {
        const url = new URL(env.WAHA_API_BASE_URL);
        if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['WAHA_API_BASE_URL'], message: 'WAHA base URL must be an HTTP origin without credentials, path, query or fragment.' });
        }
      } catch {
        // The URL field reports malformed input; do not replace its Zod error with TypeError.
      }
    }
    if (env.NODE_ENV === "production" && env.PRYMEIRA_LOCAL_AUTH_BYPASS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PRYMEIRA_LOCAL_AUTH_BYPASS"],
        message: "PRYMEIRA_LOCAL_AUTH_BYPASS cannot be true when NODE_ENV is production."
      });
    }

    if (env.NODE_ENV === "production" && !env.CORS_ORIGINS.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CORS_ORIGINS"],
        message: "CORS_ORIGINS must be configured when NODE_ENV is production."
      });
    }
  });

export type AppEnv = z.infer<typeof envSchema>;

export function readEnv(input: NodeJS.ProcessEnv = process.env): AppEnv {
  return envSchema.parse(input);
}
