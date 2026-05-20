import { createApp } from "./app.js";
import { readEnv } from "./env.js";

const env = readEnv();
const app = await createApp(env);

await app.listen({
  host: env.API_HOST,
  port: env.API_PORT
});
