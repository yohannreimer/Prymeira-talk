import { describe, expect, it, vi } from 'vitest';
import type { ChannelConnection, PrismaClient } from '@prisma/client';
vi.mock('./channel-history-canonical.js', () => ({
  persistProviderMessages: vi.fn(async ({ items }) => ({ inserted: items.length, held: 0, conversationId: null })),
  fillContactDetails: vi.fn()
}));
import { importConnectionHistory, recoverConnectionGap, recoverGapsSweep } from './provider-history.js';
import { createWahaClient } from '../waha/waha.client.js';
import { persistProviderMessages } from './channel-history-canonical.js';
const now = 1_800_000_000_000;
const connection = { id: 'c', workspaceId: 'w', channelId: 'ch', provider: 'waha', sessionName: 'session', lifecycleGeneration: 0, recoveredThroughAt: new Date(now - 600_000) } as ChannelConnection;
function database() {
  return { channel: { findUniqueOrThrow: vi.fn(async () => ({ id: 'ch', workspaceId: 'w', providerKey: 'evo' })) }, channelConnection: { updateMany: vi.fn(async () => ({ count: 1 })) } } as unknown as PrismaClient;
}
const chat = (i: number) => ({ id: `1555000${String(i).padStart(4, '0')}@c.us`, timestamp: now / 1000 });
const message = (i: number) => ({ id: `false_${chat(0).id}_M${i}`, from: chat(0).id, fromMe: false, timestamp: (now - 60_000 - i * 1000) / 1000, body: `fixture-${i}` });
describe('complete recovery windows', () => {
  it('bounds chat metadata retained across individually bounded history pages', async () => {
    const db = database(), picture = `https://provider.test/${'x'.repeat(32 * 1024)}`;
    const waha = { getChats: vi.fn(async ({ offset = 0 }) => offset < 300 ? Array.from({ length: 100 }, (_, i) => ({ ...chat(offset + i), picture })) : []), getMessages: vi.fn(async () => []) };
    await expect(importConnectionHistory(db, { waha: waha as never }, connection, { now })).rejects.toMatchObject({ code: 'HISTORY_SCAN_LIMIT' });
    expect(waha.getMessages).not.toHaveBeenCalled();
    expect(db.channelConnection.updateMany).not.toHaveBeenCalled();
  });
  it('keeps the checkpoint when individually small pages exceed the retained scan budget', async () => {
    const db = database(), body = 'x'.repeat(512 * 1024);
    const waha = { getChats: vi.fn(async ({ offset = 0 }) => offset ? [] : [chat(0)]),
      getMessages: vi.fn(async ({ offset = 0 }) => offset < 17 ? [{ ...message(offset), body }] : []) };
    vi.mocked(persistProviderMessages).mockClear();
    await expect(recoverConnectionGap(db, { waha: waha as never }, connection, { now })).rejects.toMatchObject({ code: 'HISTORY_SCAN_LIMIT' });
    expect(waha.getMessages.mock.calls.length).toBeLessThan(18);
    expect(persistProviderMessages).not.toHaveBeenCalled();
    expect(db.channelConnection.updateMany).not.toHaveBeenCalled();
  });
  it('keeps a limited connection pending and continues the next connection in the sweep', async () => {
    const db = database(), onError = vi.fn();
    db.channelConnection.findMany = vi.fn(async () => ['limited', 'healthy'].map(id => ({ ...connection, id, sessionName: id, recoveredThroughAt: new Date(Date.now() - 600_000), status: 'connected', eligible: true,
      verifiedPhoneNumber: '15550000000', lastHealthyAt: new Date(now), channel: { verifiedMessagingPhoneNumber: '15550000000' } }))) as never;
    const fetch = vi.fn(async (url: string) => url.includes('/limited/')
      ? new Response('not-read', { headers: { 'content-length': '1000' } }) : new Response('[]'));
    const waha = createWahaClient({ baseUrl: 'https://waha.example', apiKey: 'fixture', fetch: fetch as never, maxResponseBytes: 32 });
    expect(await recoverGapsSweep(db, { waha: { getChats: waha.getChats, getMessages: waha.getMessages } }, { onError })).toEqual({ recovered: 0 });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'WAHA_RESPONSE_LIMIT' }), 'limited');
    expect(db.channelConnection.updateMany).toHaveBeenCalledOnce();
    expect(db.channelConnection.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'healthy' }) }));
  });
  it('still detects changed old payloads outside the requested window', async () => {
    const db = database(); let read = 0;
    const waha = { getChats: vi.fn(async ({ offset = 0 }) => offset ? [] : [chat(0)]),
      getMessages: vi.fn(async ({ offset = 0 }) => offset ? [] : [{ ...message(0), timestamp: (now - 30 * 86_400_000) / 1000, body: `changed-${read++}` }]) };
    await expect(recoverConnectionGap(db, { waha: waha as never }, connection, { now })).rejects.toThrow('HISTORY_UNSTABLE');
    expect(db.channelConnection.updateMany).not.toHaveBeenCalled();
  });
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
