import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { readEnv } from "./env.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, "../../..");

config({ path: resolve(rootDir, ".env") });

const env = readEnv();
const app = await createApp(env);

await app.listen({
  host: env.API_HOST,
  port: env.API_PORT
});
