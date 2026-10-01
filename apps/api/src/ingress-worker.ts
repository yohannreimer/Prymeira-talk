import { createIngressRuntime, readIngressEnvironment } from './modules/ingress/runtime.js';
const config = readIngressEnvironment();
const runtime = await createIngressRuntime(config, true);
console.info(config.stage === 'isolated-1b' ? 'Isolated stage 1B worker: canonical application with durable pending effects' : 'Isolated stage 1A worker: durable pending_application handoff only');
let closing = false;
async function shutdown() { if (closing) return; closing = true; await runtime.close(); }
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
