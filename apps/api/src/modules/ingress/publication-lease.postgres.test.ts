import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { IngressJournal } from './journal.js';
import { IngressPrivateStore } from './private-store.js';
import { createIngressHttp } from './http.js';
import { IngressBackpressure, type ConfirmedIngressPublisher } from './broker.js';

const databaseUrl = process.env.MESSAGING_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('initial publication lease with PostgreSQL', () => {
  async function fixture() {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const workspaceId = randomUUID(), namespace = `talk.lease.${randomUUID()}`;
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID() } });
    const connection = await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'evolution', sessionName: channel.providerKey } });
    const root = await mkdtemp('/private/tmp/talk-publication-lease-');
    const files = new IngressPrivateStore(root); await files.initialize();
    const journal = new IngressJournal(db, files);
    const publisher = { ready: true, namespace, deadlineMs: 2000, publish: vi.fn().mockResolvedValue(undefined) } as unknown as ConfirmedIngressPublisher;
    const app = createIngressHttp({ db, journal, publisher: () => publisher, evolutionSecret: 'isolated-lease-secret', wahaSecret: 'isolated-lease-secret', workspaceAllowlist: new Set([workspaceId]) });
    const submit = () => app.inject({ method: 'POST', url: `/webhooks/evolution/${workspaceId}`, headers: { 'x-prymeira-talk-secret': 'isolated-lease-secret' },
      payload: { event: 'MESSAGES_UPSERT', instance: connection.sessionName, data: { key: { id: 'lease-test', remoteJid: '15550001111@s.whatsapp.net', fromMe: false }, message: { conversation: 'fixture' }, messageTimestamp: 1700000000 } } });
    const cleanup = async () => { await app.close(); await db.ingressReceipt.deleteMany({ where: { workspaceId } }); await db.channel.deleteMany({ where: { workspaceId } }); await db.$disconnect(); await rm(root, { recursive: true, force: true }); };
    return { db, workspaceId, journal, publisher, submit, cleanup };
  }

  it('does not let the recovery sweep steal a newly staged HTTP receipt', async () => {
    const f = await fixture();
    let releaseSweep!: () => void, sweepStarted!: () => void, sweeping = false;
    const release = new Promise<void>(resolve => { releaseSweep = resolve; });
    const started = new Promise<void>(resolve => { sweepStarted = resolve; });
    let recovery: Promise<number> | undefined;
    vi.mocked(f.publisher.publish).mockImplementation(async () => { if (sweeping) { sweepStarted(); await release; } });
    const stage = f.journal.stage.bind(f.journal);
    vi.spyOn(f.journal, 'stage').mockImplementation(async input => {
      const receipt = await stage(input);
      sweeping = true; recovery = f.journal.recover(f.publisher);
      await Promise.race([recovery, started]);
      sweeping = false;
      return receipt;
    });
    try {
      const response = await f.submit();
      expect(response.statusCode).toBe(202);
      expect(f.publisher.publish).toHaveBeenCalledTimes(1);
      expect(await f.db.ingressDelivery.findUniqueOrThrow({ where: { receiptId: response.json().receiptId } })).toMatchObject({ state: 'routed', leaseToken: null });
    } finally { releaseSweep(); await recovery; await f.cleanup(); }
  });

  it('keeps a failed broker confirmation retryable and allows recovery later', async () => {
    const f = await fixture();
    vi.mocked(f.publisher.publish).mockRejectedValueOnce(new IngressBackpressure('publish_nack'));
    try {
      expect((await f.submit()).statusCode).toBe(503);
      const delivery = await f.db.ingressDelivery.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
      expect(delivery).toMatchObject({ confirmedAt: null, leaseToken: null, lastError: 'publish_nack' });
      await f.db.ingressDelivery.update({ where: { receiptId: delivery.receiptId }, data: { nextAttemptAt: new Date(0) } });
      expect(await f.journal.recover(f.publisher)).toBe(1);
      expect((await f.db.ingressDelivery.findUniqueOrThrow({ where: { receiptId: delivery.receiptId } })).confirmedAt).not.toBeNull();
    } finally { await f.cleanup(); }
  });

  it('recovers a receipt after the initial publisher dies and its lease expires', async () => {
    const f = await fixture();
    const publish = vi.spyOn(f.journal, 'publish').mockRejectedValueOnce(new Error('isolated process interruption'));
    try {
      expect((await f.submit()).statusCode).toBe(503);
      const delivery = await f.db.ingressDelivery.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
      expect(delivery.leaseToken).not.toBeNull();
      expect(await f.journal.recover(f.publisher)).toBe(0);
      await expect(f.journal.publish(delivery.receiptId, f.publisher, 'incoming', randomUUID())).rejects.toMatchObject({ code: 'publication_in_progress' });
      await f.db.ingressDelivery.update({ where: { receiptId: delivery.receiptId }, data: { leaseUntil: new Date(0), nextAttemptAt: new Date(0) } });
      expect(await f.journal.recover(f.publisher)).toBe(1);
      expect((await f.db.ingressDelivery.findUniqueOrThrow({ where: { receiptId: delivery.receiptId } })).confirmedAt).not.toBeNull();
    } finally { publish.mockRestore(); await f.cleanup(); }
  });
});
