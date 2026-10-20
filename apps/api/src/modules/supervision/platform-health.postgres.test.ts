import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectPlatformHealth } from './platform-health.js';

const databaseUrl = process.env.SUPERVISION_TEST_DATABASE_URL;
const workspaces = [randomUUID(), randomUUID()];
const channelIds = [randomUUID(), randomUUID(), randomUUID()];
const now = new Date('2026-10-20T14:00:00Z');

describe.skipIf(!databaseUrl)('daily campaign sends on the health board (PostgreSQL)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/supervision_test') {
      throw new Error('Requires the disposable loopback supervision_test database.');
    }
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.channel.createMany({ data: channelIds.map((id, i) => ({
      id, workspaceId: workspaces[i === 1 ? 1 : 0]!, provider: 'evolution', providerKey: id
    })) });
    for (const i of [0, 1]) {
      const workspaceId = workspaces[i]!, channelId = channelIds[i]!;
      const campaign = await prisma.campaign.create({ data: {
        workspaceId, channelId, name: 'Daily sends fixture', messageBody: 'Fixture', status: 'completed', mode: 'real'
      } });
      const rows = i === 0 ? [
        ['sent', '2026-10-20T03:00:00Z', 1], // today starts at midnight in Brasília
        ['sent', '2026-10-20T13:00:00Z', 3], // attempts must not multiply a send
        ['sent', '2026-10-19T03:00:00Z', 1], // yesterday's inclusive boundary
        ['sent', '2026-10-20T02:59:59.999Z', 1], // still yesterday in Brasília
        ['sent', '2026-10-19T02:59:59.999Z', 1], // older than yesterday
        ['sent', '2026-10-21T03:00:00Z', 1], // future, outside the window
        ['failed', '2026-10-20T12:00:00Z', 2],
        ['pending', '2026-10-20T12:00:00Z', 0],
        ['uncertain', '2026-10-20T12:00:00Z', 1],
        ['sent', null, 1] // no recorded send time
      ] as const : [['sent', '2026-10-20T11:00:00Z', 1]] as const;
      await prisma.campaignRecipient.createMany({ data: rows.map(([status, sentAt, attempts], index) => ({
        workspaceId, channelId, campaignId: campaign.id, audienceKey: `fixture-${index}`,
        status, sentAt: sentAt ? new Date(sentAt) : null, attempts
      })) });
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.campaign.deleteMany({ where: { workspaceId: { in: workspaces } } });
    await prisma.channel.deleteMany({ where: { id: { in: channelIds } } });
    await prisma.$disconnect();
  });

  it('counts only successful campaign sends, by calendar day and number, once per recipient', async () => {
    const result = await collectPlatformHealth(prisma, now);
    expect(result.channels.find(c => c.channelId === channelIds[0])).toHaveProperty('campaigns', { today: 2, yesterday: 2 });
    expect(result.channels.find(c => c.channelId === channelIds[1])).toHaveProperty('campaigns', { today: 1, yesterday: 0 });
    expect(result.channels.find(c => c.channelId === channelIds[2])).toHaveProperty('campaigns', { today: 0, yesterday: 0 });
    expect(result.channels.find(c => c.channelId === channelIds[0])!.traffic.outbound24h).toBe(0);
  });

  it('rolls over at Brasília midnight rather than UTC midnight', async () => {
    const result = await collectPlatformHealth(prisma, new Date('2026-10-20T02:00:00Z'));
    expect(result.channels.find(c => c.channelId === channelIds[0])).toHaveProperty('campaigns', { today: 1, yesterday: 1 });
  });
});
