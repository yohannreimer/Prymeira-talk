import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { expect, it } from 'vitest';
const databaseUrl = process.env.MESSAGING_TEST_DATABASE_URL;

it.skipIf(!databaseUrl)('operator history backfill is scoped, resumable and has no live or outbound effects', async () => {
  const u = new URL(databaseUrl!);
  if (u.hostname !== '127.0.0.1' || u.port !== '55439' || u.pathname !== '/messaging_test') throw new Error('Only owned local messaging_test');
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const workspaceId = randomUUID(), phone = '15550009999', session = `fixture-${randomUUID()}`;
  const dir = await mkdtemp(join(tmpdir(), 'history-backfill-fixture-'));
  const from = Math.floor(Date.now() / 1000) - 86400, to = from + 3600;
  let channelId = '', mutations = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://fixture');
    res.setHeader('content-type', 'application/json');
    if (req.method !== 'GET') { mutations++; res.writeHead(405); res.end('{}'); return; }
    if (url.pathname === '/api/server/version') { res.end(JSON.stringify({ engine: 'GOWS' })); return; }
    if (url.pathname === `/api/sessions/${session}`) {
      res.end(JSON.stringify({ name: session, status: 'WORKING', me: { id: `${phone}@s.whatsapp.net` }, engine: { engine: 'GOWS', gows: { connected: true } }, config: { metadata: { workspaceId, channelId } } })); return;
    }
    if (url.pathname === `/api/${session}/chats/all/messages`) {
      expect(url.searchParams.get('filter.timestamp.gte')).toBe(String(from));
      expect(url.searchParams.get('filter.timestamp.lte')).toBe(String(to));
      const offset = Number(url.searchParams.get('offset'));
      const rows = offset ? [] : [
        { id: 'false_15550001111@c.us_FIXTUREA', from: '15550001111@c.us', fromMe: false, timestamp: from + 60, body: 'Synthetic incoming', source: 'app' },
        { id: 'true_15550001111@c.us_FIXTUREB', to: '15550001111@c.us', fromMe: true, timestamp: from + 120, body: 'Synthetic outgoing', source: 'app' }
      ];
      res.setHeader('x-talk-recovery-pagination', '1'); res.setHeader('x-talk-recovery-raw-digest', 'a'.repeat(64));
      res.setHeader('x-talk-recovery-raw-count', String(rows.length)); res.setHeader('x-talk-recovery-next-offset', String(offset + rows.length));
      res.setHeader('x-talk-recovery-exhausted', String(!rows.length)); res.end(JSON.stringify(rows)); return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: session, status: 'connected', verifiedMessagingPhoneNumber: phone } });
    channelId = channel.id;
    const checkpoint = new Date((from - 86400) * 1000);
    const c = await db.channelConnection.create({ data: { workspaceId, channelId, provider: 'waha', sessionName: session, status: 'connected', health: 'healthy', eligible: true,
      verifiedPhoneNumber: phone, lifecycleGeneration: 2, lastHealthyAt: new Date(), recoveredThroughAt: checkpoint } });
    const env = { ...process.env, DATABASE_URL: databaseUrl!, WAHA_API_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      WAHA_API_KEY: 'synthetic', TALK_MEDIA_STORE_PATH: dir };
    const args = ['src/recover-waha-history.ts', workspaceId, channelId, c.id, new Date(from * 1000).toISOString(), new Date(to * 1000).toISOString()];
    const run = async (apply = false) => JSON.parse((await promisify(execFile)('pnpm', ['exec', 'tsx', ...args, ...(apply ? ['--apply'] : [])], { env, timeout: 20_000 })).stdout.trim());
    expect(await run()).toMatchObject({ dryRun: true, firstPageRows: 2 });
    expect(await db.message.count({ where: { workspaceId } })).toBe(0);
    expect(await run(true)).toMatchObject({ complete: true, sourceRowsInPass: 2, persistedNewMessages: 2, heldInPass: 0 });
    expect(await run(true)).toMatchObject({ complete: true, persistedNewMessages: 2 });
    expect(await db.message.count({ where: { workspaceId } })).toBe(2);
    expect(await db.conversation.findMany({ where: { workspaceId }, select: { unreadCount: true } })).toEqual([{ unreadCount: 0 }]);
    expect(await db.channelConnection.findUnique({ where: { id: c.id } })).toMatchObject({ status: 'connected', lifecycleGeneration: 2, recoveredThroughAt: checkpoint });
    expect(await db.outboundDispatch.count({ where: { workspaceId } })).toBe(0);
    expect(await db.outboundIntent.count({ where: { workspaceId } })).toBe(0);
    expect(mutations).toBe(0);
  } finally {
    await new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r()));
    const where = { workspaceId };
    await db.ingressEffect.deleteMany({ where }); await db.canonicalAction.deleteMany({ where });
    await db.canonicalRecipientReceipt.deleteMany({ where }); await db.canonicalAddressEvidence.deleteMany({ where });
    await db.canonicalObservation.deleteMany({ where }); await db.canonicalNativeAlias.deleteMany({ where });
    await db.canonicalMessageIdentity.deleteMany({ where }); await db.canonicalChatMember.deleteMany({ where }); await db.canonicalChat.deleteMany({ where });
    await db.canonicalAddressAlias.deleteMany({ where }); await db.canonicalAddress.updateMany({ where, data: { redirectId: null } }); await db.canonicalAddress.deleteMany({ where });
    await db.channel.deleteMany({ where }); await db.contact.deleteMany({ where }); await db.$disconnect();
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
