import { createIngressHttp } from './modules/ingress/http.js';
import { createIngressRuntime, readIngressEnvironment } from './modules/ingress/runtime.js';
const config = readIngressEnvironment();
const runtime = await createIngressRuntime(config, false);
const app = createIngressHttp({ ...config, ...runtime });
await app.listen({ host: '127.0.0.1', port: config.port });
console.info('Isolated stage 1A ingress listening; canonical application is not connected');
let closing = false;
async function shutdown() { if (closing) return; closing = true; await app.close(); await runtime.close(); }
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
