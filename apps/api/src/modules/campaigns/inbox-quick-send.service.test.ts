import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createInboxQuickSendService, InboxQuickSendError } from './inbox-quick-send.service.js';

function setup() {
  const prisma = {
    campaign: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'campaign-1' }) },
    campaignRecipient: { count: vi.fn().mockResolvedValue(13), createMany: vi.fn().mockResolvedValue({ count: 13 }) },
    channel: { findFirst: vi.fn().mockResolvedValue({ id: 'channel-1' }) },
    contact: { findMany: vi.fn().mockResolvedValue([]) },
    campaignChannelThrottle: { upsert: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(prisma))
  };
  const service = createInboxQuickSendService(prisma as unknown as PrismaClient, () => new Date('2026-09-26T12:00:00.000Z'));
  return { prisma, service };
}

describe('inbox quick send queue', () => {
  it('persists more than ten recipients with ten-message batches and a three-minute pause', async () => {
    const { prisma, service } = setup();
    const recipients = Array.from({ length: 13 }, (_, index) => ({ phone: `554799999${String(index).padStart(4, '0')}` }));
    expect(await service.enqueue({ workspaceId: 'workspace-1', actorId: 'user-1', idempotencyKey: 'key-1',
      channelId: 'channel-1', body: 'Chapas em aço carbono', recipients })).toEqual({ campaignId: 'campaign-1', recipientsQueued: 13 });
    expect(prisma.campaign.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      status: 'sending', startMode: 'inbox_quick', activationKey: 'key-1',
      cadence: expect.objectContaining({ batchSize: 10, pauseMinSeconds: 180, pauseMaxSeconds: 180 })
    }) });
    const rows = prisma.campaignRecipient.createMany.mock.calls[0]![0].data;
    expect(rows).toHaveLength(13);
    expect(rows.map((row: { sequenceNumber: number }) => row.sequenceNumber)).toEqual(Array.from({ length: 13 }, (_, index) => index + 1));
    expect(rows[0].contactSnapshot.message).toBe('Chapas em aço carbono');
  });

  it('deduplicates numbers and reuses an idempotent queued send', async () => {
    const { prisma, service } = setup();
    const input = { workspaceId: 'workspace-1', actorId: 'user-1', idempotencyKey: 'key-1',
      channelId: 'channel-1', body: 'Olá', recipients: [{ phone: '5547999990000' }, { phone: '+55 47 99999-0000' }] };
    expect((await service.enqueue(input)).recipientsQueued).toBe(1);
    prisma.campaign.findFirst.mockResolvedValue({ id: 'campaign-1' });
    expect(await service.enqueue(input)).toEqual({ campaignId: 'campaign-1', recipientsQueued: 13 });
    expect(prisma.campaign.create).toHaveBeenCalledTimes(1);
  });

  it('rejects a saved contact from another workspace before enqueuing', async () => {
    const { prisma, service } = setup();
    await expect(service.enqueue({ workspaceId: 'workspace-1', actorId: 'user-1', idempotencyKey: 'key-1',
      channelId: 'channel-1', body: 'Olá', recipients: [{ contactId: 'foreign-id' }] }))
      .rejects.toMatchObject({ code: 'CONTACT_NOT_FOUND' } satisfies Partial<InboxQuickSendError>);
    expect(prisma.campaign.create).not.toHaveBeenCalled();
  });
});
