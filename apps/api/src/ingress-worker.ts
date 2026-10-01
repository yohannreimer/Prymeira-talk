import { createIngressRuntime, readIngressEnvironment } from './modules/ingress/runtime.js';
const runtime = await createIngressRuntime(readIngressEnvironment(), true);
console.info('Isolated stage 1A worker: durable pending_application handoff only');
let closing = false;
async function shutdown() { if (closing) return; closing = true; await runtime.close(); }
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
