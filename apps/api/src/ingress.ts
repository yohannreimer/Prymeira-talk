import { createIngressHttp } from './modules/ingress/http.js';
import { createWahaClient } from './modules/waha/waha.client.js';
import { createWahaLidResolver } from './modules/waha/waha-lid-resolver.js';
import { ALL_WORKSPACES, createIngressRuntime, readIngressEnvironment, stageAppliesReceipts } from './modules/ingress/runtime.js';
const config = readIngressEnvironment();
const runtime = await createIngressRuntime(config, false);
const wahaLids = config.wahaApi ? createWahaLidResolver(createWahaClient({ ...config.wahaApi, timeoutMs: 1_500 })) : null;
const app = createIngressHttp({ ...config, ...runtime, wahaLids, workspaceAllowlist: config.allowAllWorkspaces ? ALL_WORKSPACES : config.workspaceAllowlist });
// Loopback unless told otherwise: inside the Swarm network the container must listen on 0.0.0.0.
await app.listen({ host: process.env.INGRESS_HOST ?? '127.0.0.1', port: config.port });
console.info(stageAppliesReceipts(config.stage) ? `Ingress (${config.stage}) listening; applying receipts requires the separate canonical worker` : 'Isolated stage 1A ingress listening; canonical application is not connected');
let closing = false;
async function shutdown() { if (closing) return; closing = true; await app.close(); await runtime.close(); }
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
