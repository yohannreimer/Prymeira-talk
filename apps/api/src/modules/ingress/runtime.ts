import { PrismaClient } from '@prisma/client';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfirmedIngressPublisher, transportTopology } from './broker.js';
import { IngressPrivateStore } from './private-store.js';
import { IngressJournal } from './journal.js';
import { IngressTransportConsumer } from './consumer.js';

/** This transport-only milestone is mechanically restricted to owned loopback
 * test infrastructure. Production activation needs the later complete runtime. */
export function readIngressEnvironment(env: NodeJS.ProcessEnv = process.env) {
  if (env.INGRESS_TRANSPORT_STAGE !== 'isolated-1a') throw new Error('Stage 1A is isolated transport only');
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
  return { databaseUrl, amqpUrl, namespace, privateRoot, workspaceAllowlist, port,
    evolutionSecret: env.INGRESS_EVOLUTION_SECRET ?? '', wahaSecret: env.INGRESS_WAHA_SECRET ?? '',
    evolutionAliases: (env.INGRESS_EVOLUTION_ALIASES ?? '').split(',').filter(Boolean) };
}
export async function createIngressRuntime(config: ReturnType<typeof readIngressEnvironment>, consume: boolean) {
  const db = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  const files = new IngressPrivateStore(config.privateRoot); await files.initialize();
  const journal = new IngressJournal(db, files, config.workspaceAllowlist), abort = new AbortController();
  let publisher: ConfirmedIngressPublisher | null = null, consumer: IngressTransportConsumer | null = null;
  const loop = (async () => {
    while (!abort.signal.aborted) {
      try {
        if (!publisher?.alive) {
          await publisher?.close();
          publisher = await ConfirmedIngressPublisher.connect(config.amqpUrl, config.namespace);
        }
        if (consume && !consumer?.alive) {
          await consumer?.close();
          consumer = await IngressTransportConsumer.start({ url: config.amqpUrl, namespace: config.namespace, journal, publisher: () => publisher });
        }
        if (consume && publisher.ready) await journal.recover(publisher);
      } catch { /* Durable receipts remain pending; requests see explicit 503. */ }
      await delay(500, undefined, { signal: abort.signal }).catch(() => {});
    }
  })();
  return { db, files, journal, publisher: () => publisher,
    async close() { abort.abort(); await loop; await consumer?.close(); await publisher?.close(); await db.$disconnect(); } };
}
