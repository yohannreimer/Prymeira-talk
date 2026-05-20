import { z } from "zod";

export const envSchema = z.object({
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(3002),
  CORS_ORIGINS: z.string().default("http://localhost:5176"),
  DATABASE_URL: z.string().min(1),
  PRYMEIRA_ACCOUNT_API_URL: z.string().url(),
  PRYMEIRA_PRODUCT_KEY: z.string().default("talk"),
  CLERK_SECRET_KEY: z.string().min(1),
  EVOLUTION_WEBHOOK_SECRET: z.string().min(1)
});

export type AppEnv = z.infer<typeof envSchema>;

export function readEnv(input: NodeJS.ProcessEnv = process.env): AppEnv {
  return envSchema.parse(input);
}
