import { PrismaClient } from '@prisma/client';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfirmedIngressPublisher, transportTopology } from './broker.js';
import { IngressPrivateStore } from './private-store.js';
import { IngressJournal } from './journal.js';
import { IngressApplicationService } from './application.js';
import { IngressTransportConsumer } from './consumer.js';
import { createEffectRunner, startEffectLoop } from './effect-runner.js';
import { createMediaPrepareHandler } from './media-prepare-handler.js';
import { createMessageMediaService } from '../conversations/message-media.js';
import { MAX_SERVE_MEDIA_BYTES } from '../conversations/media-policy.js';
import { createEvolutionClient } from '../evolution/evolution.client.js';
import { createWahaClient, createWahaRuntime } from '../waha/waha.client.js';
import { createEffectHandlers } from './effect-handlers.js';
import { createRealtimeBridge } from '../realtime/realtime-bridge.js';
import { createRealtimeHub } from '../realtime/realtime-hub.js';
import { createChannelConnectionsService } from '../channels/channel-connections.js';

/** Both milestones remain restricted to owned loopback test infrastructure.
 * Stage 1B applies messages but its effects have no handlers until stage 1C. */
export function readIngressEnvironment(env: NodeJS.ProcessEnv = process.env) {
  if (!['isolated-1a','isolated-1b'].includes(env.INGRESS_TRANSPORT_STAGE ?? '')) throw new Error('Ingress requires an explicit isolated milestone');
  const databaseUrl = env.DATABASE_URL ?? '', amqpUrl = env.INGRESS_AMQP_URL ?? '';
  const db = new URL(databaseUrl), broker = new URL(amqpUrl);
  if (db.hostname !== '127.0.0.1' || db.port !== '55439' || !['/messaging_test','/campaign_test','/assistant_pilot_test','/leads_task2_test'].includes(db.pathname)) throw new Error('Owned isolated PostgreSQL required');
  if (broker.protocol !== 'amqp:' || broker.hostname !== '127.0.0.1' || broker.port !== '56739' || decodeURIComponent(broker.pathname) !== '/talk_test') throw new Error('Owned isolated RabbitMQ required');
  const namespace = env.INGRESS_NAMESPACE ?? ''; transportTopology(namespace);
  const privateRoot = env.INGRESS_PRIVATE_ROOT ?? '';
  const workspaceAllowlist = new Set((env.INGRESS_WORKSPACE_ALLOWLIST ?? '').split(',').map(v => v.trim()).filter(Boolean));
  if (!workspaceAllowlist.size) throw new Error('Isolated workspace allowlist required');
  const port = Number(env.INGRESS_PORT ?? '4011');
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid ingress port');
  return { stage: env.INGRESS_TRANSPORT_STAGE!, databaseUrl, amqpUrl, namespace, privateRoot, workspaceAllowlist, port,
    evolutionSecret: env.INGRESS_EVOLUTION_SECRET ?? '', wahaSecret: env.INGRESS_WAHA_SECRET ?? '',
    evolutionAliases: (env.INGRESS_EVOLUTION_ALIASES ?? '').split(',').filter(Boolean),
    // Effect handlers (stage 1C). Without a media store path this worker only applies receipts, as before.
    mediaStorePath: env.TALK_MEDIA_STORE_PATH ?? '',
    evolutionApi: env.EVOLUTION_API_BASE_URL && env.EVOLUTION_API_KEY ? { baseUrl: env.EVOLUTION_API_BASE_URL, apiKey: env.EVOLUTION_API_KEY } : null,
    wahaApi: env.WAHA_API_BASE_URL && env.WAHA_API_KEY ? { baseUrl: env.WAHA_API_BASE_URL, apiKey: env.WAHA_API_KEY } : null };
}
type RuntimeConfig = Omit<ReturnType<typeof readIngressEnvironment>, 'stage' | 'mediaStorePath' | 'evolutionApi' | 'wahaApi'> & { stage?: string }
  & Partial<Pick<ReturnType<typeof readIngressEnvironment>, 'mediaStorePath' | 'evolutionApi' | 'wahaApi'>>;
export async function createIngressRuntime(config: RuntimeConfig, consume: boolean) {
  const db = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  const files = new IngressPrivateStore(config.privateRoot); await files.initialize();
  const journal = new IngressJournal(db, files, config.workspaceAllowlist), abort = new AbortController();
  let publisher: ConfirmedIngressPublisher | null = null, consumer: IngressTransportConsumer | null = null;
  const loop = (async () => {
    while (!abort.signal.aborted) {
      try {
        if (!publisher?.alive) {
          await publisher?.close();
          if (abort.signal.aborted) break;
          publisher = await ConfirmedIngressPublisher.connect(config.amqpUrl, config.namespace, { signal: abort.signal });
        }
        if (abort.signal.aborted) break;
        if (consume && !consumer?.alive) {
          await consumer?.close();
          if (abort.signal.aborted) break;
          consumer = await IngressTransportConsumer.start({ url: config.amqpUrl, namespace: config.namespace, journal, publisher: () => publisher, signal: abort.signal, ...(config.stage === 'isolated-1b' ? { application: new IngressApplicationService(journal) } : {}) });
        }
        if (consume && !abort.signal.aborted && publisher.ready) await journal.recover(publisher);
      } catch { /* Durable receipts remain pending; requests see explicit 503. */ }
      await delay(500, undefined, { signal: abort.signal }).catch(() => {});
    }
  })();
  // Durable effects this process can run on its own: realtime.connection (the QR code only exists in the
  // private receipt this process owns, so it publishes to the API processes through the bridge) and,
  // with a media store configured, media.prepare. Every other effect runs in the API process.
  let bridge: ReturnType<typeof createRealtimeBridge> | null = null;
  const effects = consume && config.stage === 'isolated-1b' ? (async () => {
    bridge = createRealtimeBridge({ databaseUrl: config.databaseUrl, hub: createRealtimeHub(), logger: { warn: (fields, message) => console.warn(message, fields) } });
    await bridge.start();
    const wahaRuntime = createWahaRuntime({ enabled: !!config.wahaApi, baseUrl: config.wahaApi?.baseUrl, apiKey: config.wahaApi?.apiKey });
    const connections = createChannelConnectionsService(db, { waha: wahaRuntime });
    const handlers = createEffectHandlers({ db, realtime: bridge, journal, describeChannel: channel => connections.describe(channel as never) });
    const only: Record<string, typeof handlers[string]> = { 'realtime.connection': handlers['realtime.connection']! };
    if (config.mediaStorePath) {
      const mediaStore = new IngressPrivateStore(config.mediaStorePath, MAX_SERVE_MEDIA_BYTES + 1024 * 1024); await mediaStore.initialize();
      only['media.prepare'] = createMediaPrepareHandler({ journal, media: createMessageMediaService({ db, store: mediaStore }),
        waha: wahaRuntime.client, evolution: config.evolutionApi ? createEvolutionClient(config.evolutionApi) : null });
    }
    const runner = createEffectRunner({ db, workerId: `ingress-${process.pid}-${Math.random().toString(36).slice(2, 8)}`, handlers: only, workspaceIds: [...config.workspaceAllowlist],
      logger: { warn: (fields, message) => console.warn(message, fields) } });
    return startEffectLoop(runner, { signal: abort.signal, onError: error => console.warn('Effect loop iteration failed', error) });
  })() : null;
  let closing: Promise<void> | null = null;
  return { db, files, journal, publisher: () => publisher,
    close() {
      if (closing) return closing;
      abort.abort();
      closing = (async () => {
        // Retire current sessions immediately to unblock any loop-owned I/O.
        await Promise.all([consumer?.close(), publisher?.close()]);
        await loop;
        await effects;
        await bridge?.stop();
        // Setup already in flight when abort arrived may have assigned a session.
        await Promise.all([consumer?.close(), publisher?.close()]);
        await db.$disconnect();
      })();
      return closing;
    } };

}
