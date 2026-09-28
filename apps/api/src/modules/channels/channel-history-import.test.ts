import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { EvolutionHistorySource } from '../evolution/evolution-history.js';
import { createChannelHistoryImporter, createChannelHistoryImportScheduler } from './channel-history-import.js';

const remoteJid = '551199998888@s.whatsapp.net';
const channel = { id: 'channel-1', workspaceId: 'workspace-1', providerKey: 'instance-1', historyImportAttempts: 0 };
const records = [
  { key: { id: 'm1', remoteJid, fromMe: false }, messageTimestamp: 1_790_000_000, message: { conversation: 'Olá' } },
  { key: { id: 'm2', remoteJid, fromMe: true }, messageTimestamp: 1_790_000_030, message: { conversation: 'Bom dia' } }
];

describe('new channel history import', () => {
  it('imports history idempotently without unread messages or AI control', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const tx = {
      contact: {
        findFirst: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({ id: 'contact-1', name: null, avatarUrl: null }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      },
      conversation: {
        upsert: vi.fn().mockResolvedValue({ id: 'conversation-1' }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      },
      message: {
        findMany: vi.fn().mockImplementation(async () => rows.map(row => ({ providerMessageId: row.providerMessageId, conversationId: row.conversationId }))),
        createMany: vi.fn().mockImplementation(async ({ data }: { data: Array<Record<string, unknown>> }) => { rows.push(...data); return { count: data.length }; })
      }
    };
    const prisma = {
      $transaction: vi.fn().mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn(tx)),
      message: { count: vi.fn().mockImplementation(async () => rows.length) }
    } as unknown as PrismaClient;
    const source = {
      recentChats: vi.fn().mockResolvedValue([{ remoteJid, phoneJid: remoteJid, pushName: 'Cliente', profilePicUrl: 'https://example.com/avatar.jpg' }]),
      recentMessages: vi.fn().mockResolvedValue(records)
    } as unknown as EvolutionHistorySource;
    const onConversation = vi.fn();
    const importer = createChannelHistoryImporter({ prisma, source, onConversation });
    await expect(importer(channel)).resolves.toEqual({ conversations: 1, messages: 2 });
    await expect(importer(channel)).resolves.toEqual({ conversations: 1, messages: 0 });
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.direction)).toEqual(['inbound', 'outbound']);
    expect(rows.every(row => (row.ingestedAt as Date).getTime() === (row.createdAt as Date).getTime())).toBe(true);
    expect(tx.conversation.upsert.mock.calls[0]?.[0].create).toMatchObject({ unreadCount: 0, aiControlStatus: 'human_controlled' });
    expect(tx.contact.upsert.mock.calls[0]?.[0].create).toMatchObject({ name: 'Cliente', avatarUrl: 'https://example.com/avatar.jpg' });
    expect(onConversation).toHaveBeenCalledWith('workspace-1', 'conversation-1');
  });

  it('retries while the newly connected Evolution instance has not synchronized chats', async () => {
    const row = { ...channel, status: 'connected', historyImportStatus: 'pending' };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = { channel: { findMany: vi.fn().mockResolvedValue([row]), updateMany } } as unknown as PrismaClient;
    const source = { recentChats: vi.fn().mockResolvedValue([]) } as unknown as EvolutionHistorySource;
    const onError = vi.fn();
    const scheduler = createChannelHistoryImportScheduler({ prisma, source, onError });
    await scheduler.runOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'HISTORY_CHATS_NOT_READY' }), 'channel-1');
    expect(updateMany.mock.calls[1]?.[0].data).toMatchObject({ historyImportAttempts: { increment: 1 }, historyImportLeaseToken: null });
  });
});
