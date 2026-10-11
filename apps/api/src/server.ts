import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { readEnv } from "./env.js";
import { initializeGlitchTip, flushGlitchTip } from './observability/glitchtip.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, "../../..");

config({ path: resolve(rootDir, ".env") });
await initializeGlitchTip('api');

const env = readEnv();
const app = await createApp(env);
app.addHook('onClose', flushGlitchTip);

await app.listen({
  host: env.API_HOST,
  port: env.API_PORT
});
