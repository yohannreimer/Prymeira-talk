import { describe, expect, it, vi } from 'vitest';
import type { ChannelConnection, PrismaClient } from '@prisma/client';
vi.mock('./channel-history-canonical.js', () => ({
  persistProviderMessages: vi.fn(async ({ items }) => ({ inserted: items.length, held: 0, conversationId: null })),
  fillContactDetails: vi.fn()
}));
import { recoverConnectionGap } from './provider-history.js';
import { persistProviderMessages } from './channel-history-canonical.js';
const now = 1_800_000_000_000;
const connection = { id: 'c', workspaceId: 'w', channelId: 'ch', provider: 'waha', sessionName: 'session', lifecycleGeneration: 0, recoveredThroughAt: new Date(now - 600_000) } as ChannelConnection;
function database() {
  return { channel: { findUniqueOrThrow: vi.fn(async () => ({ id: 'ch', workspaceId: 'w', providerKey: 'evo' })) }, channelConnection: { updateMany: vi.fn(async () => ({ count: 1 })) } } as unknown as PrismaClient;
}
const chat = (i: number) => ({ id: `1555000${String(i).padStart(4, '0')}@c.us`, timestamp: now / 1000 });
const message = (i: number) => ({ id: `false_${chat(0).id}_M${i}`, from: chat(0).id, fromMe: false, timestamp: (now - 60_000 - i * 1000) / 1000, body: `fixture-${i}` });
describe('complete recovery windows', () => {
  it('exhausts more than 200 chats and more than 50 messages before advancing', async () => {
    const db = database(), chats = Array.from({ length: 205 }, (_, i) => chat(i)), messages = Array.from({ length: 73 }, (_, i) => message(i));
    const waha = { getChats: vi.fn(async ({ offset = 0, limit = 100 }) => chats.slice(offset, offset + limit)), getMessages: vi.fn(async ({ chatId, offset = 0, limit = 100 }) => chatId === chat(0).id ? messages.slice(offset, offset + limit) : []) };
    expect(await recoverConnectionGap(db, { waha: waha as never }, connection, { now })).toMatchObject({ recovered: 73, chats: 205, advanced: true });
    expect(waha.getMessages).toHaveBeenCalledWith(expect.objectContaining({ offset: 50 }));
    expect(waha.getChats).toHaveBeenCalledWith(expect.objectContaining({ offset: 200 }));
  });
  it('does not advance when the provider is unavailable', async () => {
    const db = database();
    await expect(recoverConnectionGap(db, {}, connection, { now })).rejects.toThrow('HISTORY_PROVIDER_UNAVAILABLE');
    expect(db.channelConnection.updateMany).not.toHaveBeenCalled();
  });
  it('does not certify a provider which ignores pagination, even if its page is short', async () => {
    const db = database();
    const waha = { getChats: vi.fn(async () => [chat(0)]), getMessages: vi.fn(async () => []) };
    await expect(recoverConnectionGap(db, { waha: waha as never }, connection, { now })).rejects.toThrow('HISTORY_PAGINATION');
    expect(db.channelConnection.updateMany).not.toHaveBeenCalled();
  });
  it('does not advance after a mid-window interruption and retries the complete interval', async () => {
    const db = database();
    const waha = { getChats: vi.fn(async ({ offset = 0 }) => offset ? [] : [chat(0)]), getMessages: vi.fn(async ({ offset = 0 }) => offset ? [] : [message(0)]) };
    vi.mocked(persistProviderMessages).mockRejectedValueOnce(new Error('synthetic restart'));
    await expect(recoverConnectionGap(db, { waha: waha as never }, connection, { now })).rejects.toThrow('synthetic restart');
    expect(db.channelConnection.updateMany).not.toHaveBeenCalled();
    expect(await recoverConnectionGap(db, { waha: waha as never }, connection, { now })).toMatchObject({ recovered: 1, advanced: true });
  });
  it('keeps the checkpoint when exhausted scans do not converge', async () => {
    const db = database(); let pass = 0;
    const waha = { getChats: vi.fn(async ({ offset = 0 }) => offset ? [] : [chat(pass++)]), getMessages: vi.fn(async () => []) };
    await expect(recoverConnectionGap(db, { waha: waha as never }, connection, { now })).rejects.toThrow('HISTORY_UNSTABLE');
    expect(db.channelConnection.updateMany).not.toHaveBeenCalled();
  });
});

it('keeps the checkpoint when canonical reconciliation holds part of the interval', async () => {
  const db = database();
  const waha = { getChats: vi.fn(async ({ offset = 0 }) => offset ? [] : [chat(0)]), getMessages: vi.fn(async ({ offset = 0 }) => offset ? [] : [message(0)]) };
  vi.mocked(persistProviderMessages).mockResolvedValueOnce({ inserted: 0, held: 1, conversationId: null } as never);
  expect(await recoverConnectionGap(db, { waha: waha as never }, connection, { now })).toMatchObject({ advanced: false });
  expect(db.channelConnection.updateMany).not.toHaveBeenCalled();
});
it('does not advance if the provider window changes during reconciliation', async () => {
  const db = database(); let reads = 0;
  const waha = { getChats: vi.fn(async ({ offset = 0 }) => offset ? [] : [chat(0)]), getMessages: vi.fn(async ({ offset = 0 }) => offset ? [] : [message(reads++ < 2 ? 0 : 1)]) };
  expect(await recoverConnectionGap(db, { waha: waha as never }, connection, { now })).toMatchObject({ advanced: false });
  expect(db.channelConnection.updateMany).not.toHaveBeenCalled();
});
