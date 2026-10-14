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
    /** Internal base URL of Talk's ingress as WAHA reaches it (for example http://ingress:4011). */
    WAHA_WEBHOOK_BASE_URL: optionalUrlWithProtocols(['http:', 'https:']),
    /** HMAC key WAHA signs its webhooks with; must equal the ingress INGRESS_WAHA_SECRET. */
    WAHA_WEBHOOK_HMAC_KEY: z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), z.string().min(16).optional()),
    JEV_API_KEY: optionalNonEmptyString,
    JEV_MODEL: z.string().min(1).default("jev-latest"),
    /** Workspaces on the new follow-up: comma-separated ids, "*" for all (default), or "off" to keep the old flow. */
    FOLLOWUP_BRAIN_WORKSPACES: z.string().default("*").transform((value) => value.trim().toLowerCase() === "off" ? "" : value).transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean)),
    INBOX_TRIAGE_PRIMARY: z.enum(["luna", "jev"]).default("jev"),
    INBOX_TRIAGE_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
    // Kill switch for the automatic contact name recovery job; on unless explicitly turned off.
    CONTACT_NAME_RECOVERY_ENABLED: z
      .preprocess(
        (value) => (typeof value === "string" ? value.trim().toLowerCase() || undefined : value),
        z.enum(["true", "1", "on", "false", "0", "off"]).default("true")
      )
      .transform((value) => !["false", "0", "off"].includes(value)),
    CHANNEL_WATCHDOG_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
    CHANNEL_WATCHDOG_INTERVAL_SECONDS: z.coerce.number().int().min(30).max(3600).default(120),
    // true = reads and logs only; set false to let the watchdog act
    CHANNEL_WATCHDOG_DRY_RUN: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
    TALK_UPLOAD_DIR: z.string().min(1).default("storage/uploads"),
    /** Probes redundant channels every 15 s, detects receive loss and moves the writer between connections. */
    CHANNEL_HEALTH_MONITOR_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
    /** Routes every outbound send through the single router (journal, failover, uncertain-send handling). */
    OUTBOUND_ROUTER_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
    /** Staged rollout of the whole Evolution+WAHA integration: workspace ids (comma-separated) or '*'. Workspaces outside
     * the list keep today's behaviour even with the switches below on (no WAHA button, legacy sends, legacy history). */
    WAHA_ROLLOUT_WORKSPACES: z.string().default('').transform((value) => value.trim() === '*' ? '*' as const : new Set(value.split(',').map((id) => id.trim()).filter(Boolean))),
    /** Imports channel history through the canonical store instead of writing messages directly. */
    CANONICAL_HISTORY_IMPORT_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
    /** Workspaces (comma-separated ids, or '*') served by the independent ingress; the legacy webhook refuses them with 409. */
    LEGACY_WEBHOOK_DELEGATED_WORKSPACES: z.string().default('').transform((value) => value.trim() === '*' ? '*' as const : new Set(value.split(',').map((id) => id.trim()).filter(Boolean))),
    /** Runs the durable ingress effects (assistant, agent, follow-ups, triage, automations, realtime) in this API process. */
    EFFECTS_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
    /** Comma-separated workspace ids whose effects this process may run (staged rollout). Empty = all. */
    EFFECTS_WORKSPACE_ALLOWLIST: z.string().default('').transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean)),
    /** Fan realtime events out across API processes (PostgreSQL LISTEN/NOTIFY). Off keeps one-process behaviour. */
    REALTIME_BRIDGE_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
    /** Absolute private directory for durable message media. Unset keeps the legacy media path. */
    TALK_MEDIA_STORE_PATH: z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.string().min(1).refine((value) => value.startsWith('/'), 'TALK_MEDIA_STORE_PATH must be an absolute path').optional()),
    VINCULA_CRM_API_URL: optionalUrl,
    CNPJ_DATABASE_URL: optionalUrlWithProtocols(["postgres:", "postgresql:"]),
    GOOGLE_MAPS_SCRAPER_URL: optionalUrlWithProtocols(["http:", "https:"]),
    LEAD_GOOGLE_MAX_CONCURRENT_JOBS: z.coerce.number().int().positive().default(1),
    LEAD_GOOGLE_DEFAULT_DEPTH: z.coerce.number().int().positive().max(20).default(12),
    LEAD_WHATSAPP_BATCH_SIZE: z.coerce.number().int().positive().max(25).default(25),
    LEAD_JOB_POLL_MS: z.coerce.number().int().min(1_000).max(60_000).optional(),
    /** Google Calendar the agents' schedule_meeting action books into; all three OAuth values turn it on. */
    GOOGLE_CALENDAR_CLIENT_ID: optionalNonEmptyString,
    GOOGLE_CALENDAR_CLIENT_SECRET: optionalNonEmptyString,
    GOOGLE_CALENDAR_REFRESH_TOKEN: optionalNonEmptyString,
    GOOGLE_CALENDAR_ID: z.string().trim().min(1).default("primary"),
    MEETING_TIMEZONE: z.string().trim().min(1).default("America/Sao_Paulo"),
    MEETING_DURATION_MINUTES: z.coerce.number().int().min(5).max(240).default(15),
    /** Local booking window, HH:MM-HH:MM. */
    MEETING_HOURS: z.string().trim().default("09:00-18:00"),
    /** Bookable weekdays, 0 = Sunday: ranges or lists such as 1-5 or 1,3,5. */
    MEETING_WEEKDAYS: z.string().trim().default("1-5"),
    MEETING_SLOT_STEP_MINUTES: z.coerce.number().int().min(5).max(240).default(30),
    MEETING_MIN_NOTICE_MINUTES: z.coerce.number().int().min(0).max(10_080).default(120),
    MEETING_DAYS_AHEAD: z.coerce.number().int().min(1).max(60).default(7),
    MEETING_TITLE: z.string().trim().min(1).default("Call Prymeira")
  })
  .superRefine((env, ctx) => {
    const calendarKeys = [env.GOOGLE_CALENDAR_CLIENT_ID, env.GOOGLE_CALENDAR_CLIENT_SECRET, env.GOOGLE_CALENDAR_REFRESH_TOKEN];
    if (calendarKeys.some(Boolean) && !calendarKeys.every(Boolean)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['GOOGLE_CALENDAR_REFRESH_TOKEN'], message: 'Google Calendar needs GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET and GOOGLE_CALENDAR_REFRESH_TOKEN together.' });
    }
    if (env.WAHA_WEBHOOK_BASE_URL && !env.WAHA_WEBHOOK_HMAC_KEY) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['WAHA_WEBHOOK_HMAC_KEY'], message: 'WAHA_WEBHOOK_BASE_URL requires WAHA_WEBHOOK_HMAC_KEY (at least 16 characters).' });
    }
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
