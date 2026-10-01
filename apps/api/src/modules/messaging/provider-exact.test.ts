import { describe, expect, it, vi } from 'vitest';
import { createEvolutionHistorySource } from '../evolution/evolution-history.js';
import { createWahaClient } from '../waha/waha.client.js';
import { normalizeEvolutionWebhook } from '../evolution/evolution-event-normalizer.js';
import { parseWahaMessageKey } from './whatsapp-identity.js';
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
  it.each(['data.participant', 'data.author', 'data.id.participant', 'participant', 'author', 'data.fromMe'])('rejects conflicting WAHA identity evidence in %s', async field => {
    const id = `true_${GROUP}_MSG_777@lid`;
    const payload: any = { id, fromMe: true, to: GROUP, participant: '777@lid', _data: { id, author: '777@lid' } };
    if (field === 'data.id.participant') payload._data.id = { _serialized: id, id: 'MSG', remote: GROUP, fromMe: true, participant: '888@lid' };
    else if (field === 'data.fromMe') payload._data.fromMe = false;
    else if (field.startsWith('data.')) payload._data[field.slice(5)] = '888@lid';
    else payload[field] = '888@lid';
    const fetch = vi.fn(async () => new Response(JSON.stringify(payload)));
    const client = createWahaClient({ baseUrl: 'https://waha.invalid', apiKey: 'fixture', fetch });
    expect(await client.findMessageExact({ session: 'fixture', key: parseWahaMessageKey(id, '777@lid') })).toMatchObject({ kind: 'missing' });
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
    const payload = { id, fromMe: false, media: { url: `https://waha.invalid/api/files/fixture/${encodeURIComponent(id)}.jpeg` }, _data: { id: { id: 'A', remote: GROUP, fromMe: false, participant: PN } } };
    const fetch = vi.fn(async (url: unknown) => String(url).includes('/api/files/') ? new Response('x', { headers: { 'content-length': String(9 * 1024 * 1024) } }) : new Response(JSON.stringify(payload)));
    const client = createWahaClient({ baseUrl: 'https://waha.invalid', apiKey: 'fixture', fetch });
    await expect(client.mediaExact({ session: 'fixture', key: { ...key(), nativeId: id }, purpose: 'process' })).rejects.toThrow('size limit');
    expect(await client.mediaExact({ session: 'fixture', key: { ...key(), nativeId: id }, purpose: 'serve' })).toMatchObject({ kind: 'resolved', bytes: new Uint8Array([120]) });
    payload.media.url = 'https://other.invalid/api/files/fixture';
    await expect(client.mediaExact({ session: 'fixture', key: { ...key(), nativeId: id }, purpose: 'serve' })).rejects.toThrow(/media URL/);
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

  it.each([
    '/api/files/unrelated-session/unrelated-message.jpeg',
    '/api/files/fixture/wrong-native.jpeg',
    '/api/files/fixture/../fixture/NATIVE.jpeg',
    '/api/files/fixture/%252e%252e%252fNATIVE.jpeg',
    '/api/files/fixture/NATIVE.jpeg?api_key=untrusted',
    '/api/files/fixture/NATIVE.jpeg#fragment',
    '/api/files/fixture%2fescape/NATIVE.jpeg'
  ])('rejects unbound exact WAHA media paths before download: %s', async path => {
    const nativeId = `false_${GROUP}_A_with_underscores_${PN}`;
    const payload = { id: nativeId, fromMe: false, media: { url: `https://waha.invalid${path.replace('NATIVE', encodeURIComponent(nativeId))}` },
      _data: { id: { id: 'A_with_underscores', remote: GROUP, fromMe: false, participant: PN } } };
    const fetch = vi.fn(async (url: unknown) => String(url).includes('/api/files/') ? new Response('foreign-media') : new Response(JSON.stringify(payload)));
    const client = createWahaClient({ baseUrl: 'https://waha.invalid', apiKey: 'fixture', fetch });
    await expect(client.mediaExact({ session: 'fixture', key: { ...key(), rawId: 'A_with_underscores', nativeId }, purpose: 'serve' })).rejects.toThrow(/media/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('accepts one decoded full WAHA filename with raw-ID underscores and refuses redirects', async () => {
    const nativeId = `false_${GROUP}_raw_with_many_underscores_${PN}`;
    const mediaUrl = `https://waha.invalid/api/files/fixture/${encodeURIComponent(nativeId)}.jpeg`;
    const payload = { id: nativeId, fromMe: false, media: { url: mediaUrl }, _data: { id: { id: 'raw_with_many_underscores', remote: GROUP, fromMe: false, participant: PN } } };
    let redirect = false;
    const fetch = vi.fn(async (url: unknown, _init?: RequestInit) => String(url).includes('/api/files/')
      ? redirect ? new Response(null, { status: 302, headers: { location: 'https://other.invalid/secret' } }) : new Response('owned-media')
      : new Response(JSON.stringify(payload)));
    const client = createWahaClient({ baseUrl: 'https://waha.invalid', apiKey: 'fixture', fetch });
    const input = { session: 'fixture', key: { ...key(), rawId: 'raw_with_many_underscores', nativeId }, purpose: 'serve' as const };
    expect(await client.mediaExact(input)).toMatchObject({ kind: 'resolved', bytes: new TextEncoder().encode('owned-media') });
    expect(fetch.mock.calls[1]?.[0]).toBe(mediaUrl);
    expect(fetch.mock.calls[1]?.[1]?.redirect).toBe('error');
    redirect = true;
    await expect(client.mediaExact(input)).rejects.toMatchObject({ statusCode: 302 });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it.each([1, 2])('rejects a contradictory group sender on historical page 2, pass %s', async badPass => {
    const conflicting = { ...raw, key: { ...raw.key, id: 'conflict' }, participant: '15550002222@s.whatsapp.net' };
    const exact = evo([conflicting]);
    expect(await exact.source.findMessageExact({ instanceName: 'fixture', key: { ...key(), nativeId: 'conflict', rawId: 'conflict' } })).toMatchObject({ kind: 'ambiguous' });
    let pass = 0;
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const query = JSON.parse(String(init?.body));
      if (query.where.key.id) return new Response(JSON.stringify({ messages: { pages: 1, records: [raw] } }));
      if (query.page === 1) pass++;
      const records = query.page === 1 ? [raw] : [pass === badPass ? conflicting : { ...conflicting, participant: PN }];
      return new Response(JSON.stringify({ messages: { pages: 2, records } }));
    });
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'fixture', fetch });
    const result = await source.loadExact({ instanceName: 'fixture', key: key(), from: new Date(1699999999000), to: new Date(1700000002000) });
    expect(result).toEqual({ kind: 'ambiguous' });
    expect(pass).toBe(badPass);
    // The historical parser remains compatible for explicitly legacy callers.
    expect(await exact.source.findMessage({ instanceName: 'fixture', id: 'conflict' })).toMatchObject(conflicting);
  });
  it.each([true, false])('shares exact participant PN/LID consistency with history: explicit alternate %s', async proven => {
    const item = { ...raw, key: { ...raw.key, participant: '700001@lid', participantAlt: proven ? PN : undefined }, participant: PN };
    const expected = { ...key(), nativeSenderParticipant: '700001@lid', senderParticipant: '700001@lid' };
    const { source } = evo([item]);
    expect(await source.findMessageExact({ instanceName: 'fixture', key: expected })).toMatchObject({ kind: proven ? 'resolved' : 'ambiguous' });
    // A clean anchor permits exercising page validation even when the item is invalid.
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => new Response(JSON.stringify({ messages: { pages: 1,
      records: JSON.parse(String(init?.body)).where.key.id ? [raw] : [item] } })));
    const history = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'fixture', fetch });
    const loaded = await history.loadExact({ instanceName: 'fixture', key: key(), from: new Date(1699999999000), to: new Date(1700000002000) });
    expect(loaded.kind).toBe(proven ? 'resolved' : 'ambiguous');
    if (proven && loaded.kind === 'resolved') expect(loaded.records).toEqual([item]);
  });
  it('retains consistent repeated pages, full sender alternatives and distinct directions', async () => {
    const incoming = { ...raw, participant: PN }, outgoing = { ...incoming, key: { ...raw.key, fromMe: true } };
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const query = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ messages: { pages: query.where.key.id ? 1 : 2,
        records: query.where.key.id || query.page === 1 ? [incoming] : [incoming, outgoing] } }));
    });
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'fixture', fetch });
    const result = await source.loadExact({ instanceName: 'fixture', key: key(), from: new Date(1699999999000), to: new Date(1700000002000) });
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') expect(result.records).toEqual(expect.arrayContaining([incoming, outgoing]));
    expect(fetch).toHaveBeenCalledTimes(5);
  });
  it('rejects invalid exact history parameters before provider I/O', async () => {
    const { source, fetch } = evo([raw]);
    const input = { instanceName: 'fixture', key: key(), from: new Date(1699999999000), to: new Date(1700000002000) };
    await expect(source.loadExact({ ...input, from: new Date(NaN) })).rejects.toThrow('HISTORY_WINDOW');
    await expect(source.loadExact({ ...input, to: new Date(0) })).rejects.toThrow('HISTORY_WINDOW');
    expect(await source.loadExact({ ...input, instanceName: '' })).toEqual({ kind: 'incomplete' });
    expect(await source.loadExact({ ...input, key: { ...key(), direction: null } })).toEqual({ kind: 'incomplete' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['find', 'history', 'media'] as const)('preserves conflicting same-key candidates for %s in either order or alone', async operation => {
    const clean = { ...raw, participant: PN }, corrupt = { ...clean, participant: '15550002222@s.whatsapp.net' };
    for (const records of [[clean, corrupt], [corrupt, clean], [corrupt]]) {
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const query = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ messages: { pages: 1, records: query.where?.key.id ? records : [clean] } }));
      });
      const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'fixture', fetch });
      const input = { instanceName: 'fixture', key: key(), from: new Date(1699999999000), to: new Date(1700000002000), purpose: 'serve' as const };
      const result = operation === 'find' ? await source.findMessageExact(input) : operation === 'history' ? await source.loadExact(input) : await source.mediaExact(input);
      expect(result).toEqual({ kind: 'ambiguous' });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it.each([
    { id: 'OTHER' }, { remoteJid: '120000-200@g.us' }, { fromMe: true }, { participant: '15550003333@s.whatsapp.net' }
  ])('keeps every exact native-key field when evaluating conflicting candidates: %j', async changed => {
    const clean = { ...raw, participant: PN }, foreign = { ...clean, key: { ...raw.key, ...changed }, participant: '15550002222@s.whatsapp.net' };
    expect(await evo([clean, foreign]).source.findMessageExact({ instanceName: 'fixture', key: key() })).toEqual({ kind: 'resolved', record: clean });
  });

});
