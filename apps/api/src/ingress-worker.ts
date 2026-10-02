import { createIngressRuntime, readIngressEnvironment } from './modules/ingress/runtime.js';
const config = readIngressEnvironment();
const runtime = await createIngressRuntime(config, true);
console.info(config.stage === 'isolated-1a' ? 'Isolated stage 1A worker: durable pending_application handoff only' : `Ingress worker (${config.stage}): canonical application and durable effects`);
let closing = false;
async function shutdown() { if (closing) return; closing = true; await runtime.close(); }
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
