import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createCampaignWorkerRepository } from './campaign-worker.repository.js';

function harness(hideFromInboxUntilReply: boolean) {
  const tx = {
    campaignRecipient: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'recipient-1', workspaceId: 'workspace-1',
        campaignId: 'campaign-1', channelId: 'channel-1', phoneSnapshot: '554788888888',
        contactSnapshot: {}, campaign: { hideFromInboxUntilReply } }),
      count: vi.fn().mockResolvedValue(0)
    },
    conversation: {
      upsert: vi.fn().mockResolvedValue({ id: 'conversation-1' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    message: { upsert: vi.fn().mockResolvedValue({ id: 'message-1' }) },
    campaign: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) }
  };
  const prisma = { $transaction: vi.fn((callback: (db: typeof tx) => Promise<unknown>) => callback(tx)) };
  return { tx, repository: createCampaignWorkerRepository(prisma as unknown as PrismaClient) };
}

describe('campaign worker inbox visibility', () => {
  it('hides a newly created conversation without changing the inbox sort time', async () => {
    const { tx, repository } = harness(true);
    const result = await repository.settle({ id: 'recipient-1', leaseToken: 'lease-1', status: 'sent',
      contactId: 'contact-1', message: 'Olá', sentAt: new Date('2026-09-28T20:00:00Z') });
    expect(result).toEqual({ settled: true, conversationId: 'conversation-1' });
    expect(tx.conversation.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ hiddenUntilReply: true })
    }));
    expect(tx.conversation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastMessagePreview: 'Olá',
        lastMessagePreviewAt: new Date('2026-09-28T20:00:00Z') })
    }));
    expect(tx.conversation.updateMany.mock.calls[0]![0].data).not.toHaveProperty('lastMessageAt');
    expect(tx.conversation.updateMany.mock.calls[0]![0].data).not.toHaveProperty('hiddenUntilReply');
  });

  it('shows conversations for ordinary campaigns', async () => {
    const { tx, repository } = harness(false);
    await repository.settle({ id: 'recipient-1', leaseToken: 'lease-1', status: 'sent',
      contactId: 'contact-1', message: 'Olá' });
    expect(tx.conversation.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.conversation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ hiddenUntilReply: false })
    }));
  });

  it('reuses the provider message when its webhook arrives before settlement', async () => {
    const { tx, repository } = harness(true);
    await repository.settle({ id: 'recipient-1', leaseToken: 'lease-1', status: 'sent',
      providerMessageId: 'provider-1', contactId: 'contact-1', message: 'Olá' });
    expect(tx.message.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_providerMessageId: { workspaceId: 'workspace-1',
        providerMessageId: 'provider-1' } }
    }));
  });
});
