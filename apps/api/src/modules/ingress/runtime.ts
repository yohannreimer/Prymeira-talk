import { PrismaClient } from '@prisma/client';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfirmedIngressPublisher, transportTopology } from './broker.js';
import { IngressPrivateStore } from './private-store.js';
import { IngressJournal } from './journal.js';
import { IngressApplicationService } from './application.js';
import { autoResolvePending } from '../channels/conversation-authority.js';
import { recoverGapsSweep, wahaHistorySweep } from '../channels/provider-history.js';
import { resolveLidConversationsSweep } from '../channels/lid-resolution.js';
import { createEvolutionHistorySource } from '../evolution/evolution-history.js';
import { createWahaLidResolver } from '../waha/waha-lid-resolver.js';
import { IngressTransportConsumer } from './consumer.js';
import { createEffectRunner, startEffectLoop } from './effect-runner.js';
import { createMediaPrepareHandler, createSourceMediaPreparer } from './media-prepare-handler.js';
import { createCreatedMessagesNotifier } from '../channels/created-messages-notifier.js';
import { createMessageMediaService } from '../conversations/message-media.js';
import { MAX_SERVE_MEDIA_BYTES } from '../conversations/media-policy.js';
import { createEvolutionClient } from '../evolution/evolution.client.js';
import { createWahaClient, createWahaRuntime } from '../waha/waha.client.js';
import { createEffectHandlers } from './effect-handlers.js';
import { createRealtimeBridge } from '../realtime/realtime-bridge.js';
import { createRealtimeHub } from '../realtime/realtime-hub.js';
import { createChannelConnectionsService } from '../channels/channel-connections.js';

/** Stages: `isolated-1a`/`isolated-1b` stay locked to owned loopback test infrastructure. `production` runs on the
 * real database and broker, with its own guards: a dedicated Talk RabbitMQ vhost (never the shared default one),
 * authenticated webhooks, an absolute private storage path and an explicit workspace scope. */
export const INGRESS_STAGES = ['isolated-1a', 'isolated-1b', 'production'] as const;
/** Stages that apply receipts to Talk's domain (1A only hands them off). */
export const stageAppliesReceipts = (stage: string | undefined) => stage === 'isolated-1b' || stage === 'production';
/** Accepts every workspace; only the `production` stage may ask for it, explicitly, with `*`. */
export const ALL_WORKSPACES: ReadonlySet<string> = Object.freeze(Object.assign(new Set<string>(['*']), { has: () => true })) as ReadonlySet<string>;

export function readIngressEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const stage = env.INGRESS_TRANSPORT_STAGE ?? '';
  if (!(INGRESS_STAGES as readonly string[]).includes(stage)) throw new Error('Ingress requires an explicit stage (isolated-1a, isolated-1b or production)');
  const production = stage === 'production';
  const databaseUrl = env.DATABASE_URL ?? '', amqpUrl = env.INGRESS_AMQP_URL ?? '';
  const db = new URL(databaseUrl), broker = new URL(amqpUrl);
  const vhost = decodeURIComponent(broker.pathname);
  if (!production) {
    if (db.hostname !== '127.0.0.1' || db.port !== '55439' || !['/messaging_test','/campaign_test','/assistant_pilot_test','/leads_task2_test'].includes(db.pathname)) throw new Error('Owned isolated PostgreSQL required');
    if (broker.protocol !== 'amqp:' || broker.hostname !== '127.0.0.1' || broker.port !== '56739' || vhost !== '/talk_test') throw new Error('Owned isolated RabbitMQ required');
  } else {
    if (!['postgres:', 'postgresql:'].includes(db.protocol) || !db.hostname) throw new Error('Production ingress requires a PostgreSQL DATABASE_URL');
    if (/_test$/.test(db.pathname)) throw new Error('Production ingress refuses a test database');
    if (!['amqp:', 'amqps:'].includes(broker.protocol) || !broker.hostname) throw new Error('Production ingress requires an AMQP URL');
    // The shared broker also serves other products: Talk must live in its own vhost, never in "/".
    if (!/^\/talk[a-z0-9_-]*$/i.test(vhost)) throw new Error('Production ingress requires a dedicated Talk RabbitMQ vhost (for example /talk)');
    if (!broker.username || !broker.password) throw new Error('Production ingress requires a dedicated RabbitMQ user for Talk');
  }
  const namespace = env.INGRESS_NAMESPACE ?? ''; transportTopology(namespace);
  // A stage may only use its own queues: a test run can never consume production traffic, nor the reverse.
  if (production !== namespace.startsWith('talk.prod.')) throw new Error(production ? 'Production ingress requires a talk.prod.* namespace' : 'Isolated ingress requires a talk.isolated.* namespace');
  const privateRoot = env.INGRESS_PRIVATE_ROOT ?? '';
  const listed = (env.INGRESS_WORKSPACE_ALLOWLIST ?? '').split(',').map(v => v.trim()).filter(Boolean);
  const allowAllWorkspaces = production && listed.length === 1 && listed[0] === '*';
  const workspaceAllowlist = new Set(allowAllWorkspaces ? [] : listed);
  if (!allowAllWorkspaces && !workspaceAllowlist.size) throw new Error(production ? 'Production ingress requires INGRESS_WORKSPACE_ALLOWLIST (workspace ids, or * for all)' : 'Isolated workspace allowlist required');
  if (!production && listed.includes('*')) throw new Error('Only the production stage may accept every workspace');
  const port = Number(env.INGRESS_PORT ?? '4011');
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid ingress port');
  const evolutionSecret = env.INGRESS_EVOLUTION_SECRET ?? '', wahaSecret = env.INGRESS_WAHA_SECRET ?? '';
  if (production) {
    if (!privateRoot.startsWith('/')) throw new Error('Production ingress requires an absolute INGRESS_PRIVATE_ROOT');
    if (evolutionSecret.length < 16 || wahaSecret.length < 16) throw new Error('Production ingress requires INGRESS_EVOLUTION_SECRET and INGRESS_WAHA_SECRET (at least 16 characters)');
    if (env.TALK_MEDIA_STORE_PATH && !env.TALK_MEDIA_STORE_PATH.startsWith('/')) throw new Error('TALK_MEDIA_STORE_PATH must be an absolute path');
  }
  return { stage, databaseUrl, amqpUrl, namespace, privateRoot, workspaceAllowlist, allowAllWorkspaces, port,
    evolutionSecret, wahaSecret,
    evolutionAliases: (env.INGRESS_EVOLUTION_ALIASES ?? '').split(',').filter(Boolean),
    // Effect handlers. Without a media store path this worker only applies receipts and runs realtime.connection.
    mediaStorePath: env.TALK_MEDIA_STORE_PATH ?? '',
    evolutionApi: env.EVOLUTION_API_BASE_URL && env.EVOLUTION_API_KEY ? { baseUrl: env.EVOLUTION_API_BASE_URL, apiKey: env.EVOLUTION_API_KEY } : null,
    wahaApi: env.WAHA_API_BASE_URL && env.WAHA_API_KEY ? { baseUrl: env.WAHA_API_BASE_URL, apiKey: env.WAHA_API_KEY } : null,
    // Off by default. Enable only once this workspace's Evolution webhook goes to the ingress (rollout step "corte"):
    // while the legacy route still writes, a recovered copy could duplicate what it writes later.
    gapRecovery: env.INGRESS_RECOVERY_ENABLED === 'true',
    wahaHistoryImport: env.WAHA_HISTORY_IMPORT_ENABLED === 'true' };
}
type RuntimeConfig = Omit<ReturnType<typeof readIngressEnvironment>, 'stage' | 'mediaStorePath' | 'evolutionApi' | 'wahaApi' | 'allowAllWorkspaces' | 'gapRecovery' | 'wahaHistoryImport'> & { stage?: string; allowAllWorkspaces?: boolean }
  & Partial<Pick<ReturnType<typeof readIngressEnvironment>, 'mediaStorePath' | 'evolutionApi' | 'wahaApi' | 'gapRecovery' | 'wahaHistoryImport'>>;
export async function createIngressRuntime(config: RuntimeConfig, consume: boolean) {
  const db = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  const files = new IngressPrivateStore(config.privateRoot); await files.initialize();
  const journal = new IngressJournal(db, files, config.allowAllWorkspaces ? undefined : config.workspaceAllowlist), abort = new AbortController();
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
          consumer = await IngressTransportConsumer.start({ url: config.amqpUrl, namespace: config.namespace, journal, publisher: () => publisher, signal: abort.signal, ...(stageAppliesReceipts(config.stage) ? { application: new IngressApplicationService(journal) } : {}) });
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
  const effects = consume && stageAppliesReceipts(config.stage) ? (async () => {
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
    const runner = createEffectRunner({ db, workerId: `ingress-${process.pid}-${Math.random().toString(36).slice(2, 8)}`, handlers: only, ...(config.allowAllWorkspaces ? {} : { workspaceIds: [...config.workspaceAllowlist] }),
      logger: { warn: (fields, message) => console.warn(message, fields) } });
    return startEffectLoop(runner, { signal: abort.signal, onError: error => console.warn('Effect loop iteration failed', error) });
  })() : null;
  // Events held as stale_source (they arrived while a connection was being paired or reset) are certified once the
  // connection is current again. Nothing is lost while it is not: the receipt and the held decision stay on record.
  const recertifier = consume && stageAppliesReceipts(config.stage) ? (async () => {
    const application = new IngressApplicationService(journal);
    const wahaClient = config.wahaApi ? createWahaClient(config.wahaApi) : null;
    const history: Parameters<typeof recoverGapsSweep>[1] = { evolution: config.evolutionApi ? createEvolutionHistorySource(config.evolutionApi) : null, waha: wahaClient,
      wahaLids: wahaClient ? createWahaLidResolver(wahaClient) : null };
    // Messages read back from a provider (WAHA history, gap recovery) get durable media and reach open inboxes live.
    let historyBridge: ReturnType<typeof createRealtimeBridge> | null = null;
    if (config.gapRecovery || config.wahaHistoryImport) {
      historyBridge = createRealtimeBridge({ databaseUrl: config.databaseUrl, hub: createRealtimeHub(), logger: { warn: (fields, message) => console.warn(message, fields) } });
      await historyBridge.start();
      const mediaStore = config.mediaStorePath ? new IngressPrivateStore(config.mediaStorePath, MAX_SERVE_MEDIA_BYTES + 1024 * 1024) : null;
      await mediaStore?.initialize();
      history.after = { notify: createCreatedMessagesNotifier(db, event => historyBridge!.publish(event)),
        prepareMedia: mediaStore ? createSourceMediaPreparer({ media: createMessageMediaService({ db, store: mediaStore }), waha: wahaClient,
          evolution: config.evolutionApi ? createEvolutionClient(config.evolutionApi) : null }) : undefined };
    }
    const warnFor = (step: 'waha_history' | 'gap_recovery' | 'lid_resolution') => (error: unknown, connectionId: string) =>
      console.warn(`Provider ${step} step failed`, { step, connectionId, error: error instanceof Error ? error.message : String(error) });
    let lastRecovery = 0;
    let historyRun: Promise<unknown> | null = null;
    while (!abort.signal.aborted) {
      await delay(30_000, undefined, { signal: abort.signal }).catch(() => {});
      if (abort.signal.aborted) break;
      try {
        const scope = config.allowAllWorkspaces ? {} : { workspaceIds: [...config.workspaceAllowlist] };
        await application.recertifyPending(scope);
        await autoResolvePending(db, scope); // Old duplicate conversations: the phone-number default decides.
        // A first WAHA history import can take many minutes (GOWS brings the phone's whole sync); it runs on its own,
        // one at a time, so recertification, LID resolution and gap recovery keep their 30 s rhythm meanwhile.
        if (config.wahaHistoryImport && !historyRun) {
          historyRun = wahaHistorySweep(db, history, { ...scope, onError: warnFor('waha_history') })
            .catch(error => warnFor('waha_history')(error, '*')).finally(() => { historyRun = null; });
        }
        // Conversations known only by a LID (Evolution history without a phone) get their number from WAHA.
        if (config.wahaHistoryImport && history.wahaLids) await resolveLidConversationsSweep(db, { lids: history.wahaLids }, { ...scope, onError: warnFor('lid_resolution') });
        if (config.gapRecovery && Date.now() - lastRecovery >= 5 * 60_000) { lastRecovery = Date.now(); await recoverGapsSweep(db, history, { ...scope, onError: warnFor('gap_recovery') }); }
      }
      catch (error) { console.warn('Recertification sweep failed', error); }
    }
    await historyRun;
    await historyBridge?.stop();
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
        await recertifier;
        await bridge?.stop();
        // Setup already in flight when abort arrived may have assigned a session.
        await Promise.all([consumer?.close(), publisher?.close()]);
        await db.$disconnect();
      })();
      return closing;
    } };

}
