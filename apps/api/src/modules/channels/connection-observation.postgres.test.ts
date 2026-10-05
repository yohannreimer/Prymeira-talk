import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyAuthenticatedConnectionObservation } from './channel-connections.js';
import { normalizeEvolutionWebhook } from '../evolution/evolution-event-normalizer.js';
import type { TrustedMessagingContext } from '../messaging/normalized-event.js';

const url = process.env.MESSAGING_TEST_DATABASE_URL;

describe.skipIf(!url)('connection observations on PostgreSQL', () => {
  let db: PrismaClient;
  const workspaces: string[] = [];
  beforeAll(() => { db = new PrismaClient({ datasources: { db: { url } } }); });
  afterAll(async () => {
    await db.channel.deleteMany({ where: { workspaceId: { in: workspaces } } });
    await db.$disconnect();
  });
  async function fixture(verifiedPhoneNumber: string | null) {
    const workspaceId = randomUUID(); workspaces.push(workspaceId);
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID(), status: 'connected' } });
    const connection = await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'evolution', sessionName: channel.providerKey,
      status: 'connected', health: 'healthy', eligible: true, verifiedPhoneNumber } });
    const context: TrustedMessagingContext = { workspaceId, channelId: channel.id, provider: 'evolution', channelProvider: 'evolution', connectionId: connection.id,
      sessionName: connection.sessionName, lifecycleGeneration: 0, mode: 'live', observedAt: new Date().toISOString() };
    const observe = async (data: Record<string, unknown>) => {
      const result = normalizeEvolutionWebhook(context, { event: 'connection.update', instance: connection.sessionName, data });
      if (result.kind !== 'accepted' || result.event.kind !== 'control') throw new Error('Expected control');
      const event = result.event;
      await db.$transaction(tx => applyAuthenticatedConnectionObservation(tx, event));
      return db.channelConnection.findUniqueOrThrow({ where: { id: connection.id } });
    };
    return { observe };
  }

  it('Vendas 06 on 05/10: connecting then open as the same account puts the primary back in use', async () => {
    const { observe } = await fixture('554789126453');
    expect(await observe({ state: 'connecting', statusReason: 200 })).toMatchObject({ status: 'connecting', eligible: false });
    expect(await observe({ state: 'open', wuid: '554789126453@s.whatsapp.net', statusReason: 200 })).toMatchObject({ status: 'connected', eligible: true, verifiedPhoneNumber: '554789126453' });
  });
  it('learns the number of a primary that was never verified', async () => {
    const { observe } = await fixture(null);
    await observe({ state: 'connecting' });
    expect(await observe({ state: 'open', wuid: '554789126453:12@s.whatsapp.net' })).toMatchObject({ eligible: true, verifiedPhoneNumber: '554789126453' });
  });
  it('keeps it out of use when it opens as another account or says nothing about the account', async () => {
    const other = await fixture('554789126453');
    await other.observe({ state: 'connecting' });
    expect(await other.observe({ state: 'open', wuid: '554700000000@s.whatsapp.net' })).toMatchObject({ status: 'connected', eligible: false, verifiedPhoneNumber: '554789126453' });
    const silent = await fixture('554789126453');
    await silent.observe({ state: 'connecting' });
    expect(await silent.observe({ state: 'open' })).toMatchObject({ status: 'connected', eligible: false });
  });
});
