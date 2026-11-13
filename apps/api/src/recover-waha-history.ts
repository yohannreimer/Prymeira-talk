import { PrismaClient } from '@prisma/client';
import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createWahaClient } from './modules/waha/waha.client.js';
import { createWahaLidResolver, lidsIn } from './modules/waha/waha-lid-resolver.js';
import { pairedConnections, wahaItems } from './modules/channels/provider-history.js';
import { persistProviderMessages } from './modules/channels/channel-history-canonical.js';
import { normalizeWhatsappPhone, wahaEngineReady } from './modules/channels/channel-connections.js';
import { newHistoryBackfill, stepHistoryBackfill, type HistoryBackfillCursor } from './modules/channels/waha-history-backfill.js';

// No session lifecycle actions, agents, outbound effects or live-frontier updates.
const [workspaceId, channelId, connectionId, fromIso, toIso, flag] = process.argv.slice(2);
if (![workspaceId, channelId, connectionId].every(x => /^[a-f0-9-]{36}$/.test(x ?? '')) || !fromIso || !toIso || (flag !== undefined && flag !== '--apply')) {
  throw new Error('Usage: recover-waha-history <workspace-id> <channel-id> <connection-id> <from-iso> <to-iso> [--apply]');
}
const from = Date.parse(fromIso) / 1000, to = Date.parse(toIso) / 1000;
const initial = newHistoryBackfill(from, to), apply = flag === '--apply';
if (to * 1000 > Date.now() - 30_000) throw new Error('BACKFILL_SETTLE');
const db = new PrismaClient();
let release: (() => Promise<void>) | undefined;
try {
  const channel = await db.channel.findUniqueOrThrow({ where: { id: channelId } });
  const connection = (await pairedConnections(db, { workspaceIds: [workspaceId!] })).find(c => c.id === connectionId && c.channelId === channelId && c.provider === 'waha');
  if (channel.workspaceId !== workspaceId || channel.archivedAt || !connection) throw new Error('BACKFILL_SOURCE_NOT_ELIGIBLE');
  if (!process.env.WAHA_API_BASE_URL || !process.env.WAHA_API_KEY) throw new Error('BACKFILL_PROVIDER_CONFIG');
  const client = createWahaClient({ baseUrl: process.env.WAHA_API_BASE_URL, apiKey: process.env.WAHA_API_KEY, timeoutMs: 15_000 });
  const session = await client.getSession({ session: connection.sessionName });
  if (session.name !== connection.sessionName || session.status !== 'WORKING' || !wahaEngineReady(session)
    || session.config?.metadata?.workspaceId !== workspaceId || session.config?.metadata?.channelId !== channelId
    || normalizeWhatsappPhone(session.me?.id) !== normalizeWhatsappPhone(connection.verifiedPhoneNumber)) throw new Error('BACKFILL_PROVIDER_OWNERSHIP');
  const generation = connection.lifecycleGeneration;
  if (!apply) {
    const page = await client.getRecoveryMessages({ session: connection.sessionName, from, to, offset: 0, limit: 50 });
    console.info(JSON.stringify({ dryRun: true, workspaceId, channelId, connectionId, generation, from: fromIso, to: toIso,
      firstPageRows: page.rawCount, checkpointPreserved: connection.recoveredThroughAt, noSessionRestart: true }));
  } else {
    const dir = join(process.env.TALK_MEDIA_STORE_PATH ?? '/data/media', 'talk-history-ops');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const job = createHash('sha256').update(JSON.stringify([workspaceId, channelId, connectionId, generation, from, to])).digest('hex');
    const file = join(dir, `${job}.json`), lock = `${file}.lock`;
    const handle = await open(lock, 'wx', 0o600);
    release = async () => { await handle.close(); await unlink(lock); };
    const scope = { workspaceId, channelId, connectionId, generation, from, to };
    let cursor = initial;
    try {
      const saved = JSON.parse(await readFile(file, 'utf8')) as { scope: typeof scope; cursor: HistoryBackfillCursor };
      if (JSON.stringify(saved.scope) !== JSON.stringify(scope)) throw new Error('BACKFILL_CHECKPOINT_SCOPE');
      cursor = saved.cursor;
      if (cursor.from !== from || cursor.to !== to) throw new Error('BACKFILL_CHECKPOINT_RANGE');
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const lids = createWahaLidResolver(client);
    const save = async (value: HistoryBackfillCursor) => {
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ scope, cursor: value }), { mode: 0o600 }); await rename(temp, file);
    };
    const freshSource = async () => {
      const fresh = await db.channelConnection.findUniqueOrThrow({ where: { id: connection.id } });
      if (fresh.lifecycleGeneration !== generation || fresh.sessionName !== connection.sessionName || fresh.status !== 'connected' || !fresh.eligible) throw new Error('BACKFILL_SOURCE_CHANGED');
    };
    const started = Date.now();
    for (let turn = 0; turn < 20 && Date.now() - started < 40_000 && !cursor.complete; turn++) {
      await freshSource();
      await stepHistoryBackfill({ session: connection.sessionName, cursor, maxPages: 1,
        read: q => client.getRecoveryMessages(q), save,
        persist: async messages => {
          await freshSource();
          const mappings: Array<{ lid: string; pn: string }> = [];
          for (const lid of new Set(messages.flatMap(m => lidsIn({ id: m.id, from: m.from, to: m.to, participant: m.participant }, 10)))) {
            const pn = await lids.lookup(connection.sessionName, lid);
            if (!pn) throw new Error('HISTORY_CHAT_IDENTITY_INCOMPLETE');
            mappings.push({ lid, pn });
          }
          return persistProviderMessages({ prisma: db, channel: { id: channel.id, workspaceId: channel.workspaceId, providerKey: channel.providerKey },
            connection: { id: connection.id, provider: 'waha', lifecycleGeneration: generation, sessionName: connection.sessionName },
            mode: 'history', items: wahaItems(connection.sessionName, messages, mappings), batchId: job });
        }
      });
    }
    console.info(JSON.stringify({ apply: true, workspaceId, channelId, connectionId, generation, from: fromIso, to: toIso,
      complete: cursor.complete, sourceRowsInPass: cursor.complete ? cursor.offset : null, offset: cursor.offset,
      persistedNewMessages: cursor.inserted, heldInPass: Object.values(cursor.holdsByOffset).reduce((a, b) => a + b, 0),
      checkpointFile: file, checkpointPreserved: connection.recoveredThroughAt, noSessionRestart: true }));
  }
} finally { await release?.(); await db.$disconnect(); }
