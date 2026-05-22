import { z } from "zod";

const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional()
);

const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().url().optional()
);

export const envSchema = z.object({
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(3002),
  CORS_ORIGINS: z.string().default("http://localhost:5176"),
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
  EVOLUTION_WEBHOOK_SECRET: z.string().min(1)
});

export type AppEnv = z.infer<typeof envSchema>;

export function readEnv(input: NodeJS.ProcessEnv = process.env): AppEnv {
  return envSchema.parse(input);
}
