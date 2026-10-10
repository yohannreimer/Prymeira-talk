import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { EvolutionHistorySource } from '../evolution/evolution-history.js';
import { createChannelHistoryImporter, createChannelHistoryImportScheduler } from './channel-history-import.js';

const remoteJid = '551199998888@s.whatsapp.net';
const channel = { id: 'channel-1', workspaceId: 'workspace-1', providerKey: 'instance-1', historyImportAttempts: 0 };
const records = [
  { key: { id: 'm1', remoteJid, fromMe: false }, messageTimestamp: 1_790_000_000, message: { conversation: 'Olá' }, pushName: 'Cliente' },
  { key: { id: 'm2', remoteJid, fromMe: true }, messageTimestamp: 1_790_000_030, message: { conversation: 'Bom dia' } }
];

describe('new channel history import', () => {
  // Fixed historical fixtures must be tested against a fixed clock. Otherwise the
  // real 15-day import cutoff eventually ages them out and invalidates these assertions.
  beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(1_790_000_120 * 1000); });
  afterEach(() => { vi.restoreAllMocks(); });
  it('uses the phone conversation when a chat has both phone and LID identities', async () => {
    const lidJid = '123456789012345@lid';
    const phoneContact = { id: 'phone-contact', phone: '551199998888', name: null, avatarUrl: null };
    const findFirst = vi.fn().mockImplementation(async ({ where }: { where: { phone?: { in?: string[] } } }) =>
      where.phone?.in?.includes(phoneContact.phone) ? phoneContact : null);
    const upsert = vi.fn();
    const tx = { contact: { findFirst, upsert, updateMany: vi.fn().mockResolvedValue({ count: 1 }) }, conversation: {
      upsert: vi.fn().mockResolvedValue({ id: 'phone-conversation' }), updateMany: vi.fn().mockResolvedValue({ count: 1 })
    }, message: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn().mockResolvedValue({ count: 1 }) } };
    const prisma = { $transaction: vi.fn().mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn(tx)) } as unknown as PrismaClient;
    const source = { recentMessages: vi.fn().mockResolvedValue([{ ...records[0], key: { ...records[0]!.key, remoteJid: lidJid } }]) } as unknown as EvolutionHistorySource;
    await createChannelHistoryImporter({ prisma, source }).importChat(channel,
      { remoteJid: lidJid, phoneJid: remoteJid, pushName: null, profilePicUrl: null }, 30);
    expect(findFirst.mock.calls[0]?.[0].where.phone.in).not.toContain(lidJid);
    expect(tx.conversation.upsert.mock.calls[0]?.[0].where.workspaceId_channelId_contactId.contactId).toBe(phoneContact.id);
    expect(upsert).not.toHaveBeenCalled();
  });
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
      contact: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      message: { count: vi.fn().mockImplementation(async () => rows.length) }
    } as unknown as PrismaClient;
    const source = {
      recentContacts: vi.fn().mockResolvedValue([]),
      recentChats: vi.fn().mockResolvedValue({ chats: [{ remoteJid, phoneJid: remoteJid, pushName: null, profilePicUrl: 'https://example.com/avatar.jpg' }], unresolvedLids: 0 }),
      recentMessages: vi.fn().mockResolvedValue(records)
    } as unknown as EvolutionHistorySource;
    const onConversation = vi.fn();
    const importer = createChannelHistoryImporter({ prisma, source, onConversation });
    await expect(importer({ ...channel, historyImportAttempts: 3 })).rejects.toThrow('HISTORY_CHATS_SETTLING');
    await expect(importer({ ...channel, historyImportAttempts: 3 })).resolves.toEqual({ conversations: 1, messages: 0 });
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.direction)).toEqual(['inbound', 'outbound']);
    expect(rows.every(row => (row.ingestedAt as Date).getTime() === (row.createdAt as Date).getTime())).toBe(true);
    expect(tx.conversation.upsert.mock.calls[0]?.[0].create).toMatchObject({ unreadCount: 0, aiControlStatus: 'human_controlled' });
    expect(tx.contact.upsert.mock.calls[0]?.[0].create).toMatchObject({ name: 'Cliente', avatarUrl: 'https://example.com/avatar.jpg' });
    expect(onConversation).toHaveBeenCalledWith('workspace-1', 'conversation-1');
    expect(source.recentMessages).toHaveBeenCalledWith({ instanceName: 'instance-1', remoteJid, limit: 30 });
  });

  it('imports a location sent through Business with coordinates and historical provenance', async () => {
    const tx = {
      contact: { findFirst: vi.fn().mockResolvedValue({ id: 'contact-1', name: 'Cliente' }) },
      conversation: { upsert: vi.fn().mockResolvedValue({ id: 'conversation-1' }), updateMany: vi.fn() },
      message: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn().mockResolvedValue({ count: 1 }) }
    };
    const prisma = { $transaction: vi.fn().mockImplementation(async fn => fn(tx)) } as unknown as PrismaClient;
    const source = { recentMessages: vi.fn().mockResolvedValue([{ ...records[1], messageType: 'locationMessage',
      message: { locationMessage: { name: 'Grupo Villefer', address: 'Joinville', degreesLatitude: -26.254, degreesLongitude: -48.875 } } }]) } as unknown as EvolutionHistorySource;
    await createChannelHistoryImporter({ prisma, source }).importChat(channel,
      { remoteJid, phoneJid: remoteJid, pushName: null, profilePicUrl: null }, 30);
    expect(tx.message.createMany).toHaveBeenCalledWith(expect.objectContaining({ data: [expect.objectContaining({
      direction: 'outbound', type: 'text', body: expect.stringContaining('Grupo Villefer'),
      metadata: expect.objectContaining({ historyImport: expect.objectContaining({ source: 'evolution' }),
        location: expect.objectContaining({ latitude: -26.254, longitude: -48.875 }) })
    })] }));
  });

  it('retries while the newly connected Evolution instance has not synchronized chats', async () => {
    const row = { ...channel, status: 'connected', historyImportStatus: 'pending' };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = { channel: { findMany: vi.fn().mockResolvedValue([row]), updateMany } } as unknown as PrismaClient;
    const source = { recentContacts: vi.fn().mockResolvedValue([]), recentChats: vi.fn().mockResolvedValue({ chats: [], unresolvedLids: 0 }) } as unknown as EvolutionHistorySource;
    const onError = vi.fn();
    const scheduler = createChannelHistoryImportScheduler({ prisma, source, onError });
    await scheduler.runOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(updateMany.mock.calls[1]?.[0].data).toMatchObject({ historyImportAttempts: { increment: 1 }, historyImportLeaseToken: null });
  });

  it('rechecks a partial chat list before marking the import complete', async () => {
    const prisma = { contact: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn() }, message: { count: vi.fn().mockResolvedValue(1) } } as unknown as PrismaClient;
    const source = {
      recentContacts: vi.fn().mockResolvedValue([]),
      recentChats: vi.fn().mockResolvedValue({ chats: [{ remoteJid, phoneJid: remoteJid, pushName: null, profilePicUrl: null }], unresolvedLids: 0 }),
      recentMessages: vi.fn().mockResolvedValue([])
    } as unknown as EvolutionHistorySource;
    const importer = createChannelHistoryImporter({ prisma, source });
    await expect(importer(channel)).rejects.toThrow('HISTORY_CHATS_SETTLING');
    await expect(importer({ ...channel, historyImportAttempts: 3 })).resolves.toEqual({ conversations: 1, messages: 0 });
  });

  it('completes after importing addressable LID chats without phone mapping', async () => {
    const prisma = { contact: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn() }, message: { count: vi.fn().mockResolvedValue(1) } } as unknown as PrismaClient;
    const source = {
      recentContacts: vi.fn().mockResolvedValue([]),
      recentChats: vi.fn().mockResolvedValue({ chats: [{ remoteJid, phoneJid: remoteJid, pushName: null, profilePicUrl: null }], unresolvedLids: 4 }),
      recentMessages: vi.fn().mockResolvedValue([])
    } as unknown as EvolutionHistorySource;
    await expect(createChannelHistoryImporter({ prisma, source })({ ...channel, historyImportAttempts: 20 })).resolves.toEqual({ conversations: 1, messages: 0 });
    expect(source.recentChats).toHaveBeenCalledWith({ instanceName: 'instance-1', limit: 1000, since: expect.any(Date) });
  });

  it('never completes an empty history even after repeated attempts', async () => {
    const source = { recentContacts: vi.fn().mockResolvedValue([]), recentChats: vi.fn().mockResolvedValue({ chats: [], unresolvedLids: 0 }) } as unknown as EvolutionHistorySource;
    const importer = createChannelHistoryImporter({ prisma: {} as PrismaClient, source });
    await expect(importer({ ...channel, historyImportAttempts: 20 })).rejects.toThrow('HISTORY_CHATS_NOT_READY');
  });

  it('saves the whole phone contact book and restores missing saved names', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = { contact: {
      findMany: vi.fn().mockResolvedValue([{ id: 'old', phone: '551199998888', name: null, avatarUrl: null }]),
      createMany, updateMany
    } } as unknown as PrismaClient;
    const source = { recentContacts: vi.fn().mockResolvedValue([
      { phoneJid: remoteJid, name: 'Nome salvo', profilePicUrl: null },
      { phoneJid: '551188887777@s.whatsapp.net', name: 'Outro contato', profilePicUrl: null }
    ]), recentChats: vi.fn().mockResolvedValue({ chats: [], unresolvedLids: 0 }) } as unknown as EvolutionHistorySource;
    await expect(createChannelHistoryImporter({ prisma, source })(channel)).rejects.toThrow('HISTORY_CHATS_NOT_READY');
    expect(createMany.mock.calls[0]?.[0].data).toMatchObject([{ phone: '551188887777', name: 'Outro contato' }]);
    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({ where: { id: 'old', name: null }, data: { name: 'Nome salvo' } });
  });

  describe('meaningless WhatsApp names', () => {
    function chatTx(existing: { id: string; name: string | null; avatarUrl: string | null } | null) {
      return {
        contact: {
          findFirst: vi.fn().mockResolvedValue(existing),
          upsert: vi.fn().mockResolvedValue({ id: 'contact-1', name: null, avatarUrl: null }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 })
        },
        conversation: { upsert: vi.fn().mockResolvedValue({ id: 'conversation-1' }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        message: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn().mockResolvedValue({ count: 1 }) }
      };
    }
    const prismaFor = (tx: unknown) => ({ $transaction: vi.fn().mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn(tx)) } as unknown as PrismaClient);
    const ownLast = { key: { id: 'own', remoteJid, fromMe: true }, messageTimestamp: 1_790_000_060, message: { conversation: 'Até mais' }, pushName: 'Você' };

    it('creates the contact without a name when the only name comes from our own last message', async () => {
      const tx = chatTx(null);
      const source = { recentMessages: vi.fn().mockResolvedValue([ownLast]) } as unknown as EvolutionHistorySource;
      await createChannelHistoryImporter({ prisma: prismaFor(tx), source }).importChat(channel,
        { remoteJid, phoneJid: remoteJid, pushName: 'Você', profilePicUrl: null }, 30);
      expect(tx.contact.upsert.mock.calls[0]?.[0].create).toMatchObject({ name: null });
      expect(tx.contact.updateMany).not.toHaveBeenCalled();
    });

    it.each(['Você', '556392370750', '103547450441825@lid'])('never patches an unnamed contact with %j', async (pushName) => {
      const tx = chatTx({ id: 'contact-1', name: null, avatarUrl: null });
      const source = { recentMessages: vi.fn().mockResolvedValue([{ ...records[0], pushName }, ownLast]) } as unknown as EvolutionHistorySource;
      await createChannelHistoryImporter({ prisma: prismaFor(tx), source }).importChat(channel,
        { remoteJid, phoneJid: remoteJid, pushName, profilePicUrl: null }, 30);
      expect(tx.contact.updateMany).not.toHaveBeenCalled();
    });

    it('falls back to the last inbound real name when the chat name is a placeholder', async () => {
      const tx = chatTx({ id: 'contact-1', name: null, avatarUrl: null });
      const source = { recentMessages: vi.fn().mockResolvedValue([records[0], { ...records[0], key: { ...records[0]!.key, id: 'm3' }, pushName: 'Você' }, ownLast]) } as unknown as EvolutionHistorySource;
      await createChannelHistoryImporter({ prisma: prismaFor(tx), source }).importChat(channel,
        { remoteJid, phoneJid: remoteJid, pushName: 'Você', profilePicUrl: null }, 30);
      expect(tx.contact.updateMany).toHaveBeenCalledWith({ where: { workspaceId: 'workspace-1', id: 'contact-1' }, data: { name: 'Cliente' } });
    });

    it('stores a real chat name', async () => {
      const tx = chatTx(null);
      const source = { recentMessages: vi.fn().mockResolvedValue([ownLast]) } as unknown as EvolutionHistorySource;
      await createChannelHistoryImporter({ prisma: prismaFor(tx), source }).importChat(channel,
        { remoteJid, phoneJid: remoteJid, pushName: 'Juliana - Metal MIB', profilePicUrl: null }, 30);
      expect(tx.contact.upsert.mock.calls[0]?.[0].create).toMatchObject({ name: 'Juliana - Metal MIB' });
    });

    it('never creates or updates contact names from placeholder, phone or WhatsApp-id names', async () => {
      const createMany = vi.fn().mockResolvedValue({ count: 3 });
      const updateMany = vi.fn().mockResolvedValue({ count: 1 });
      const prisma = { contact: {
        findMany: vi.fn().mockResolvedValue([{ id: 'old', phone: '551199998888', name: null, avatarUrl: null }]),
        createMany, updateMany
      } } as unknown as PrismaClient;
      const source = { recentContacts: vi.fn().mockResolvedValue([
        { phoneJid: remoteJid, name: 'Você', profilePicUrl: null },
        { phoneJid: '556392370750@s.whatsapp.net', name: '556392370750', profilePicUrl: null },
        { phoneJid: '103547450441825@lid', name: '103547450441825@lid', profilePicUrl: null },
        { phoneJid: '551188887777@s.whatsapp.net', name: 'You', profilePicUrl: null },
        { phoneJid: '551177776666@s.whatsapp.net', name: 'Ana', profilePicUrl: null }
      ]), recentChats: vi.fn().mockResolvedValue({ chats: [], unresolvedLids: 0 }) } as unknown as EvolutionHistorySource;
      await expect(createChannelHistoryImporter({ prisma, source })(channel)).rejects.toThrow('HISTORY_CHATS_NOT_READY');
      expect(createMany.mock.calls[0]?.[0].data).toEqual([
        { workspaceId: 'workspace-1', phone: '556392370750', name: null, avatarUrl: null },
        { workspaceId: 'workspace-1', phone: '103547450441825@lid', name: null, avatarUrl: null },
        { workspaceId: 'workspace-1', phone: '551188887777', name: null, avatarUrl: null },
        { workspaceId: 'workspace-1', phone: '551177776666', name: 'Ana', avatarUrl: null }
      ]);
      expect(updateMany).not.toHaveBeenCalled();
    });

    it('keeps a real chat name over a placeholder from the contact book during a channel import', async () => {
      const tx = chatTx(null);
      const prisma = { ...prismaFor(tx),
        contact: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn().mockResolvedValue({ count: 2 }), updateMany: vi.fn() },
        message: { count: vi.fn().mockResolvedValue(1) } } as unknown as PrismaClient;
      const otherJid = '551188887777@s.whatsapp.net';
      const source = {
        recentContacts: vi.fn().mockResolvedValue([{ phoneJid: remoteJid, name: 'Você', profilePicUrl: null }]),
        recentChats: vi.fn().mockImplementation(async () => ({ chats: [
          { remoteJid, phoneJid: remoteJid, pushName: 'Cliente', profilePicUrl: null },
          { remoteJid: otherJid, phoneJid: otherJid, pushName: 'Você', profilePicUrl: null }
        ], unresolvedLids: 0 })),
        recentMessages: vi.fn().mockResolvedValue([ownLast])
      } as unknown as EvolutionHistorySource;
      await createChannelHistoryImporter({ prisma, source })({ ...channel, historyImportAttempts: 3 }).catch(() => undefined);
      expect(tx.contact.upsert.mock.calls.map((call) => call[0].create.name)).toEqual(['Cliente', null]);
    });
  });

  it('keeps older chat identities available as contacts without importing their conversations', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = { contact: { findMany: vi.fn().mockResolvedValue([]), createMany, updateMany: vi.fn() } } as unknown as PrismaClient;
    const oldChat = { remoteJid, phoneJid: remoteJid, pushName: 'Cliente antigo', profilePicUrl: null };
    const source = { recentContacts: vi.fn().mockResolvedValue([]),
      recentChats: vi.fn().mockResolvedValueOnce({ chats: [oldChat], unresolvedLids: 0 }).mockResolvedValueOnce({ chats: [], unresolvedLids: 0 }) } as unknown as EvolutionHistorySource;
    const importer = createChannelHistoryImporter({ prisma, source });
    await expect(importer({ ...channel, historyImportAttempts: 3 })).resolves.toEqual({ conversations: 0, messages: 0 });
    expect(createMany).toHaveBeenCalledWith({ data: [{ workspaceId: 'workspace-1', phone: '551199998888', name: 'Cliente antigo', avatarUrl: null }], skipDuplicates: true });
  });

describe('staged rollout of the canonical history import', () => {
  it('a workspace outside the rollout keeps the legacy writer even with the canonical import on', async () => {
    const findFirst = vi.fn().mockResolvedValue(null), connection = vi.fn();
    const tx = { contact: { findFirst, upsert: vi.fn().mockResolvedValue({ id: 'c1', name: null, avatarUrl: null }), updateMany: vi.fn() },
      conversation: { upsert: vi.fn().mockResolvedValue({ id: 'conv-1' }), updateMany: vi.fn() },
      message: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn().mockResolvedValue({ count: 2 }) } };
    const prisma = { $transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(tx)), channelConnection: { findFirst: connection } } as unknown as PrismaClient;
    const source = { recentMessages: vi.fn().mockResolvedValue(records) } as unknown as EvolutionHistorySource;
    const imported = await createChannelHistoryImporter({ prisma, source, canonical: (workspaceId) => workspaceId === 'another-workspace' })
      .importChat(channel, { remoteJid, phoneJid: remoteJid, pushName: null, profilePicUrl: null }, 30);
    expect(imported).toBe(2);
    expect(tx.message.createMany).toHaveBeenCalledTimes(1);
    expect(connection).not.toHaveBeenCalled();
  });
});
});
