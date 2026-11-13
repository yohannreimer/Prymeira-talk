import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyAuthenticatedConnectionObservation } from './channel-connections.js';
import { normalizeEvolutionWebhook } from '../evolution/evolution-event-normalizer.js';
import { normalizeWahaEvent } from '../waha/waha-normalizer.js';
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
    return { observe, readChannel: () => db.channel.findUniqueOrThrow({ where: { id: channel.id } }) };
  }

  it('records a WAHA STARTING outage once without granting eligibility when WORKING returns', async () => {
    const workspaceId = randomUUID(); workspaces.push(workspaceId);
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID(), status: 'connected', verifiedMessagingPhoneNumber: '15550000000' } });
    const c = await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'waha', sessionName: randomUUID(),
      status: 'connected', health: 'healthy', eligible: true, verifiedPhoneNumber: '15550000000' } });
    const at = Math.floor(Date.now() / 1000) * 1000;
    const observe = async (status: string, offset: number) => {
      const context: TrustedMessagingContext = { workspaceId, channelId: channel.id, provider: 'waha', channelProvider: 'evolution', connectionId: c.id,
        sessionName: c.sessionName, lifecycleGeneration: c.lifecycleGeneration, mode: 'live', observedAt: new Date(at + offset).toISOString() };
      const n = normalizeWahaEvent(context, { event: 'session.status', session: c.sessionName, payload: { status } });
      if (n.kind !== 'accepted' || n.event.kind !== 'control') throw Error('Invalid status fixture');
      const event = n.event; await db.$transaction(tx => applyAuthenticatedConnectionObservation(tx, event));
      return db.channelConnection.findUniqueOrThrow({ where: { id: c.id } });
    };
    expect(await observe('STARTING', 0)).toMatchObject({ status: 'connecting', eligible: false, disconnectedAt: new Date(at) });
    expect(await observe('STARTING', 60_000)).toMatchObject({ disconnectedAt: new Date(at) });
    expect(await observe('WORKING', 120_000)).toMatchObject({ status: 'connected', eligible: false, disconnectedAt: new Date(at), lifecycleGeneration: 0 });
  });
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
    expect(await other.observe({ state: 'open', wuid: '554700000000@s.whatsapp.net' })).toMatchObject({ status: 'connected', eligible: false, verifiedPhoneNumber: '554700000000' });
    expect(await other.readChannel()).toMatchObject({ status: 'disconnected', verifiedMessagingPhoneNumber: '554789126453' });
    // A repeated observation of the wrong account cannot replace the expected identity.
    expect(await other.observe({ state: 'open', wuid: '554700000000@s.whatsapp.net' })).toMatchObject({ eligible: false });
    const silent = await fixture('554789126453');
    await silent.observe({ state: 'connecting' });
    expect(await silent.observe({ state: 'open' })).toMatchObject({ status: 'connected', eligible: false });
  });
});
