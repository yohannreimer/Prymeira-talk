import { describe, expect, it, vi } from 'vitest';
import { createEvolutionHistorySource } from '../evolution/evolution-history.js';
import { createWahaClient } from '../waha/waha.client.js';
import { normalizeEvolutionWebhook } from '../evolution/evolution-event-normalizer.js';
import type { TrustedMessagingContext } from './normalized-event.js';
const PN = '15550001111@s.whatsapp.net', GROUP = '120000-100@g.us';
const context: TrustedMessagingContext = { workspaceId: 'workspace', channelId: 'channel', provider: 'evolution', channelProvider: 'evolution', connectionId: 'physical', sessionName: 'fixture', lifecycleGeneration: 0, mode: 'history', observedAt: '2026-09-30T12:00:00Z' };
const raw = { key: { id: 'A', remoteJid: GROUP, fromMe: false, participant: PN, participantAlt: '700001@lid' }, messageTimestamp: 1700000000, message: { conversation: 'hello' } };
function key() {
  const normalized = normalizeEvolutionWebhook(context, { event: 'messages.upsert', data: raw });
  if (normalized.kind !== 'accepted' || normalized.event.kind !== 'message') throw new Error('fixture');
  return normalized.event.key;
}
function evo(records: unknown[]) {
  const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ messages: { records, pages: 1 } })));
  return { fetch, source: createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'fixture', fetch }) };
}
describe('exact provider I/O contracts', () => {
  it('retains group sender and alternate through history parsing and normalization', async () => {
    const { source } = evo([raw]);
    const record = await source.findMessage({ instanceName: 'fixture', id: 'A' });
    expect(record?.key).toMatchObject({ participant: PN, participantAlt: '700001@lid' });
    const normalized = normalizeEvolutionWebhook(context, { event: 'messages.upsert', data: record });
    expect(normalized.kind === 'accepted' && normalized.event.kind === 'message' && normalized.event.key.senderParticipant).toBe(PN);
  });
  it('queries Evolution using the full native key and validates response identity', async () => {
    const { source, fetch } = evo([raw]);
    expect(await source.findMessageExact({ instanceName: 'fixture', key: key() })).toMatchObject({ kind: 'resolved', record: raw });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).where.key).toMatchObject({ id: 'A', remoteJid: GROUP, fromMe: false, participant: PN });
    const wrong = evo([{ ...raw, key: { ...raw.key, participant: '15550002222@s.whatsapp.net' } }]);
    expect(await wrong.source.findMessageExact({ instanceName: 'fixture', key: key() })).toMatchObject({ kind: 'missing' });
    expect(await evo([raw, raw]).source.findMessageExact({ instanceName: 'fixture', key: key() })).toMatchObject({ kind: 'ambiguous' });
  });
  it('accepts alternate mapping only when explicitly present in the exact response', async () => {
    const expected = { ...key(), nativeChatAddress: '700001@lid', chatAddress: PN, nativeSenderParticipant: null, senderParticipant: '' };
    const item = { ...raw, key: { id: 'A', remoteJid: '700001@lid', remoteJidAlt: PN, fromMe: false } };
    expect(await evo([item]).source.findMessageExact({ instanceName: 'fixture', key: expected })).toMatchObject({ kind: 'resolved' });
    expect(await evo([{ ...item, key: { ...item.key, remoteJidAlt: undefined } }]).source.findMessageExact({ instanceName: 'fixture', key: expected })).toMatchObject({ kind: 'missing' });
  });
  it('exact Evolution media first proves the full key and passes it to media I/O', async () => {
    const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify(fetch.mock.calls.length === 1 ? { messages: { records: [raw], pages: 1 } } : { base64: 'YQ==', mimetype: 'image/png' })));
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'fixture', fetch });
    expect(await source.mediaExact({ instanceName: 'fixture', key: key(), purpose: 'process' })).toMatchObject({ kind: 'resolved', mediaUrl: 'data:image/png;base64,YQ==' });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).message.key).toEqual(raw.key);
  });
  it('WAHA validates returned structured identity without guessing serialized suffixes', async () => {
    const id = `false_${GROUP}_A_${PN}`;
    const payload = { id, fromMe: false, _data: { id: { id: 'A', remote: GROUP, fromMe: false, participant: PN } } };
    const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify(payload)));
    const client = createWahaClient({ baseUrl: 'https://waha.invalid', apiKey: 'fixture', fetch });
    expect(await client.findMessageExact({ session: 'fixture', key: { ...key(), nativeId: id } })).toMatchObject({ kind: 'resolved' });
    expect(await client.findMessageExact({ session: 'fixture', key: { ...key(), nativeId: id, senderParticipant: '15550002222@s.whatsapp.net' } })).toMatchObject({ kind: 'missing' });
    payload._data.id.participant = undefined as unknown as string;
    expect(await client.findMessageExact({ session: 'fixture', key: { ...key(), nativeId: id } })).toMatchObject({ kind: 'missing' });
  });
  it('rejects WAHA contradictory serialized versus structured full keys', async () => {
    const id = `true_${GROUP}_A_${PN}`;
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id, fromMe: false, _data: { id: { id: 'A', remote: GROUP, fromMe: false, participant: PN } } })));
    const client = createWahaClient({ baseUrl: 'https://waha.invalid', apiKey: 'fixture', fetch });
    expect(await client.findMessageExact({ session: 'fixture', key: { ...key(), nativeId: id } })).toMatchObject({ kind: 'missing' });
  });
  it('does not request media when the exact provider identity is absent', async () => {
    const { source, fetch } = evo([]);
    expect(await source.mediaExact({ instanceName: 'fixture', key: key(), purpose: 'serve' })).toMatchObject({ kind: 'missing' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('exact anchor validates full identity and retains group sender collisions in history', async () => {
    const other = { ...raw, key: { ...raw.key, participant: '15550002222@s.whatsapp.net', participantAlt: undefined } };
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => new Response(JSON.stringify({ messages: { pages: 1,
      records: JSON.parse(String(init?.body)).where.key.id ? [raw] : [raw, other] } })));
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'fixture', fetch });
    expect(await source.loadExact({ instanceName: 'fixture', key: key(), from: new Date(1699999999000), to: new Date(1700000001000) })).toMatchObject({ kind: 'resolved', records: [expect.objectContaining({ key: expect.objectContaining({ participant: PN }) }), expect.objectContaining({ key: expect.objectContaining({ participant: '15550002222@s.whatsapp.net' }) })] });
    expect(await source.loadExact({ instanceName: 'fixture', key: { ...key(), direction: 'outbound' }, from: new Date(1699999999000), to: new Date(1700000001000) })).toMatchObject({ kind: 'missing' });
  });
  it('WAHA exact media enforces process and serving limits plus the configured origin', async () => {
    const id = `false_${GROUP}_A_${PN}`;
    const payload = { id, fromMe: false, media: { url: 'https://waha.invalid/api/files/fixture' }, _data: { id: { id: 'A', remote: GROUP, fromMe: false, participant: PN } } };
    const fetch = vi.fn(async (url: unknown) => String(url).includes('/api/files/') ? new Response('x', { headers: { 'content-length': String(9 * 1024 * 1024) } }) : new Response(JSON.stringify(payload)));
    const client = createWahaClient({ baseUrl: 'https://waha.invalid', apiKey: 'fixture', fetch });
    await expect(client.mediaExact({ session: 'fixture', key: { ...key(), nativeId: id }, purpose: 'process' })).rejects.toThrow('size limit');
    expect(await client.mediaExact({ session: 'fixture', key: { ...key(), nativeId: id }, purpose: 'serve' })).toMatchObject({ kind: 'resolved', bytes: new Uint8Array([120]) });
    payload.media.url = 'https://other.invalid/api/files/fixture';
    await expect(client.mediaExact({ session: 'fixture', key: { ...key(), nativeId: id }, purpose: 'serve' })).rejects.toThrow('configured file origin');
  });

  it('Evolution exact media retains separate 8 MiB processing and 25 MiB serving budgets', async () => {
    const base64 = Buffer.alloc(9 * 1024 * 1024).toString('base64');
    const fetch = vi.fn(async (url: unknown) => new Response(JSON.stringify(String(url).includes('getBase64') ? { base64, mimetype: 'image/png' } : { messages: { records: [raw], pages: 1 } })));
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'fixture', fetch });
    await expect(source.mediaExact({ instanceName: 'fixture', key: key(), purpose: 'process' })).rejects.toThrow(/LIMIT/);
    const result = await source.mediaExact({ instanceName: 'fixture', key: key(), purpose: 'serve' });
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') expect(result.mediaUrl.length).toBe(base64.length + 'data:image/png;base64,'.length);
  });

});
