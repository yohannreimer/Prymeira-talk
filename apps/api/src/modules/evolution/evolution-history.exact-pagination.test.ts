import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { createEvolutionHistorySource } from './evolution-history.js';
import type { WhatsAppMessageKey } from '../messaging/whatsapp-identity.js';

const id = 'BROADCAST-ID', pn = '15550000150@s.whatsapp.net', lid = '700150@lid';
const expected: WhatsAppMessageKey = { identityFormat: 'whatsapp_stanza', nativeId: id, rawId: id,
  nativeChatAddress: pn, chatAddress: pn, nativeSenderParticipant: null, senderParticipant: '', direction: 'outbound' };
const row = (index: number, copy = 0) => ({ id: `physical-${copy}-${index}`,
  key: index === 150 ? { id, remoteJid: lid, remoteJidAlt: pn, fromMe: true }
    : { id, remoteJid: `1555000${String(index).padStart(4, '0')}@s.whatsapp.net`, fromMe: true },
  messageTimestamp: 1_800_000_000, message: { imageMessage: { url: 'https://media.invalid/expired', caption: `recipient-${index}` } } });
const native = () => { const { id: _, ...message } = row(150); return message; };
const broadcast = () => [0, 1].flatMap(copy => Array.from({ length: 204 }, (_, index) => row(index, copy)));
// Evolution includes the numeric broadcast-list envelope beside recipient copies.
const withEnvelope = () => broadcast().map((item, index) => index % 204 === 0 ? { ...item,
  key: { id, remoteJid: '1800000000@broadcast', fromMe: true }, instanceId: 'owned-instance-internal',
  source: 'android', contextInfo: { fixture: 'broadcast-envelope' }, MessageUpdate: [] } : item);

function provider(rows = broadcast(), alter?: (messages: any, page: number, pass: number, capacity: number) => void) {
  let pass = -1;
  const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).includes('getBase64')) return Response.json({ base64: 'YQ==', mimetype: 'image/png' });
    if (body.page === 1 && (rows.length <= 100 || body.offset === 5000)) pass++;
    const messages = { pages: Math.ceil(rows.length / body.offset), total: rows.length, currentPage: body.page,
      records: rows.slice((body.page - 1) * body.offset, body.page * body.offset) };
    alter?.(messages, body.page, pass, body.offset);
    return Response.json({ messages });
  });
  return { fetch, source: createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'synthetic', fetch }) };
}
const lookup = { instanceName: 'owned-instance', key: expected };

describe('complete bounded Evolution broadcast lookup', () => {
  it('refuses a singleton prefix with omitted total before requesting any media', async () => {
    const fetch = vi.fn(async (url: unknown) => String(url).includes('getBase64')
      ? Response.json({ base64: 'YQ==', mimetype: 'image/png' })
      : Response.json({ messages: { pages: 1, currentPage: 1, records: [row(150)] } }));
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'synthetic', fetch });
    expect(await source.mediaExact({ ...lookup, purpose: 'serve' })).toEqual({ kind: 'ambiguous' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('verifies the terminal page even for a declared singleton', async () => {
    const f = provider([row(150)], (messages, page) => { if (page === 2) messages.records = [row(150, 1)]; });
    await expect(f.source.mediaExact({ ...lookup, purpose: 'serve' })).rejects.toThrow('HISTORY_PAGINATION');
    expect(f.fetch.mock.calls.some(([url]) => String(url).includes('getBase64'))).toBe(false);
  });
  it.each(['recipients', 'numeric envelope'] as const)('resolves 408 physical broadcast rows with %s despite overlapping small pages and sends only the original candidate key', async fixture => {
    const rows = fixture === 'numeric envelope' ? withEnvelope() : broadcast(), pages: { page: number; offset: number }[] = [], media: unknown[] = [];
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        response.setHeader('content-type', 'application/json');
        if (request.headers.apikey !== 'synthetic') { response.writeHead(403).end('{}'); return; }
        if (request.url === '/chat/findMessages/owned-instance' && isDeepStrictEqual(body.where, { key: { id } }) && [100, 5000].includes(body.offset)) {
          pages.push({ page: body.page, offset: body.offset });
          const records = rows.slice((body.page - 1) * body.offset, body.page * body.offset);
          // Timestamp ties let the real provider repeat one physical ID across small pages.
          if (body.offset === 100 && body.page === 2) records[0] = rows[99]!;
          response.end(JSON.stringify({ messages: { pages: Math.ceil(rows.length / body.offset), total: 408, currentPage: body.page,
            records } })); return;
        }
        if (request.url === '/chat/getBase64FromMediaMessage/owned-instance' && isDeepStrictEqual(body.message, native())) {
          media.push(body.message); response.end(JSON.stringify({ base64: 'YQ==', mimetype: 'image/png' })); return;
        }
        response.writeHead(400).end('{}');
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const source = createEvolutionHistorySource({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: 'synthetic' });
      expect(await source.mediaExact({ ...lookup, purpose: 'serve' })).toEqual({ kind: 'resolved', record: native(), mediaUrl: 'data:image/png;base64,YQ==' });
      expect(pages).toEqual([{ page: 1, offset: 100 }, { page: 1, offset: 5000 }, { page: 2, offset: 5000 },
        { page: 1, offset: 5000 }, { page: 2, offset: 5000 }]);
      expect(media).toEqual([native()]);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it.each([
    ['status namespace', (r: any) => { r.key.remoteJid = 'status@broadcast'; }],
    ['unknown namespace', (r: any) => { r.key.remoteJid = '1800000000@unknown'; }],
    ['nonnumeric broadcast', (r: any) => { r.key.remoteJid = 'other@broadcast'; }],
    ['empty stanza ID', (r: any) => { r.key.id = ''; }],
    ['different stanza ID', (r: any) => { r.key.id = 'OTHER-ID'; }],
    ['missing direction', (r: any) => { delete r.key.fromMe; }],
    ['string direction', (r: any) => { r.key.fromMe = 'true'; }],
    ['null timestamp', (r: any) => { r.messageTimestamp = null; }],
    ['millisecond timestamp', (r: any) => { r.messageTimestamp = 1_800_000_000_000; }],
    ['nonobject message', (r: any) => { r.message = []; }],
    ['direct alias', (r: any) => { r.key.remoteJidAlt = pn; }],
    ['group alias', (r: any) => { r.key.remoteJidAlt = '120000-1@g.us'; }],
    ['native group participant', (r: any) => { r.key.participant = pn; }],
    ['group participant alias', (r: any) => { r.key.participantAlt = pn; }],
    ['outer group participant', (r: any) => { r.participant = pn; }],
    ['outer direct chat', (r: any) => { r.remoteJid = pn; }],
    ['outer contradictory chat and direction', (r: any) => { r.remoteJid = pn; r.fromMe = false; }],
    ['outer chat alias', (r: any) => { r.remoteJidAlt = pn; }],
    ['outer direction', (r: any) => { r.fromMe = false; }],
    ['outer author', (r: any) => { r.author = pn; }],
    ['outer participant alias', (r: any) => { r.participantAlt = pn; }]
  ] as const)('retains strict failure for a broadcast envelope with %s', async (_name, change) => {
    const rows = withEnvelope(); change(rows[0]); const f = provider(rows);
    await expect(f.source.mediaExact({ ...lookup, purpose: 'serve' })).rejects.toThrow('HISTORY_RECORD');
    expect(f.fetch.mock.calls.some(([url]) => String(url).includes('getBase64'))).toBe(false);
  });
  it.each([
    { ...expected, chatAddress: '1800000000@broadcast', nativeChatAddress: '1800000000@broadcast' },
    { ...expected, nativeChatAddress: '1800000000@broadcast' },
    { ...expected, chatAddress: '120000-1@g.us', nativeChatAddress: '1800000000@broadcast', senderParticipant: pn, nativeSenderParticipant: pn }
  ])('refuses broadcast input even with contradictory canonical chat claims', async key => {
    const f = provider(withEnvelope());
    expect(await f.source.mediaExact({ ...lookup, key, purpose: 'serve' })).toEqual({ kind: 'incomplete' });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('requires convergence of the complete raw broadcast envelope metadata', async () => {
    const f = provider(withEnvelope(), (messages, page, pass) => {
      if (page === 1) messages.records[0] = { ...messages.records[0], contextInfo: { pass }, MessageUpdate: [{ pass }] };
    });
    await expect(f.source.mediaExact({ ...lookup, purpose: 'serve' })).rejects.toThrow('HISTORY_UNSTABLE');
    expect(f.fetch).toHaveBeenCalledTimes(7);
    expect(f.fetch.mock.calls.some(([url]) => String(url).includes('getBase64'))).toBe(false);
  });
  it('counts full raw envelope bytes against the cumulative scan budget', async () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({ ...withEnvelope()[0]!, id: `envelope-${index}`,
      contextInfo: { opaque: 'x'.repeat(512 * 1024) } }));
    const f = provider(rows);
    await expect(f.source.mediaExact({ ...lookup, purpose: 'serve' })).rejects.toMatchObject({ code: 'HISTORY_SCAN_LIMIT' });
    expect(f.fetch).toHaveBeenCalledOnce();
  });
  it.each(['chat', 'direction', 'participant'] as const)('does not resolve another %s even when every row shares the requested ID', async field => {
    const rows = withEnvelope().map(item => item.key.remoteJid === lid ? { ...item, key: { ...item.key,
      ...(field === 'chat' ? { remoteJid: '700999@lid', remoteJidAlt: '15559999999@s.whatsapp.net' } : {}),
      ...(field === 'direction' ? { fromMe: false } : {}),
      ...(field === 'participant' ? { participant: '15559999999@s.whatsapp.net' } : {}) } } : item);
    const f = provider(rows);
    expect(await f.source.findMessageExact(lookup)).toEqual({ kind: 'missing' });
    expect(f.fetch.mock.calls.some(([url]) => String(url).includes('getBase64'))).toBe(false);
  });
  it('retains conflicting payloads and distinct PN/LID native tuples as ambiguous', async () => {
    for (const change of [(item: ReturnType<typeof row>) => ({ ...item, message: { imageMessage: { ...item.message.imageMessage, caption: 'changed' } } }),
      (item: ReturnType<typeof row>) => ({ ...item, key: { ...item.key, remoteJid: pn, remoteJidAlt: lid } }),
      (item: ReturnType<typeof row>) => ({ ...item, messageTimestamp: item.messageTimestamp + 1 }),
      (item: ReturnType<typeof row>) => ({ ...item, pushName: 'Different sender name' }),
      (item: ReturnType<typeof row>) => ({ ...item, messageType: 'videoMessage' })]) {
      const rows = broadcast(); rows[354] = change(rows[354]!);
      const f = provider(rows);
      expect(await f.source.mediaExact({ ...lookup, purpose: 'serve' })).toEqual({ kind: 'ambiguous' });
      expect(f.fetch.mock.calls.some(([url]) => String(url).includes('getBase64'))).toBe(false);
    }
  });
  it('deduplicates even a single-page pair only after two exhausted stable scans', async () => {
    const f = provider([row(150), row(150, 1)]);
    expect(await f.source.findMessageExact(lookup)).toEqual({ kind: 'resolved', record: native() });
    expect(f.fetch).toHaveBeenCalledTimes(4);
  });
  it('does not let a contradictory group sender disappear behind a clean copy', async () => {
    const group = '120000-1@g.us', sender = '15551111111@s.whatsapp.net';
    const key = { ...expected, nativeChatAddress: group, chatAddress: group, nativeSenderParticipant: sender, senderParticipant: sender };
    const rows = withEnvelope().map(item => item.key.remoteJid === lid ? { ...item, key: { id, remoteJid: group, fromMe: true, participant: sender },
      ...(item.id === 'physical-1-150' ? { participant: '15552222222@s.whatsapp.net' } : {}) } : item);
    expect(await provider(rows).source.findMessageExact({ ...lookup, key })).toEqual({ kind: 'ambiguous' });
  });
  it('requires explicit group participant PN/LID proof throughout the complete broadcast lookup', async () => {
    const group = '120000-1@g.us', sender = '15551111111@s.whatsapp.net', nativeSender = '711111@lid';
    const key = { ...expected, nativeChatAddress: group, chatAddress: group, nativeSenderParticipant: sender, senderParticipant: sender };
    const rows = withEnvelope().map(item => item.key.remoteJid === lid ? { ...item,
      key: { id, remoteJid: group, fromMe: true, participant: nativeSender, participantAlt: sender } } : item);
    const f = provider(rows);
    expect(await f.source.mediaExact({ ...lookup, key, purpose: 'serve' })).toMatchObject({ kind: 'resolved',
      record: { key: { remoteJid: group, participant: nativeSender, participantAlt: sender } } });
    const last = f.fetch.mock.calls.at(-1)!;
    expect(JSON.parse(String(last[1]?.body)).message.key).toEqual(rows[150]!.key);
    const unrelated = rows.map(item => item.key.remoteJid === group ? { ...item, key: { ...item.key, participantAlt: '15552222222@s.whatsapp.net' } } : item);
    expect(await provider(unrelated).source.findMessageExact({ ...lookup, key })).toEqual({ kind: 'missing' });
    const incomplete = rows.map(item => item.id === 'physical-1-150' ? { ...item, key: { ...item.key, participant: undefined, participantAlt: undefined } } : item);
    expect(await provider(incomplete).source.findMessageExact({ ...lookup, key })).toEqual({ kind: 'ambiguous' });
    expect(await provider(incomplete.filter(item => item.key.remoteJid === group)).source.findMessageExact({ ...lookup, key })).toEqual({ kind: 'ambiguous' });
  });
  it.each(['missing', 'repeated', 'wrong-current', 'changed-total', 'changed-pages', 'not-exhausted'] as const)('rejects %s pagination without fetching media', async fault => {
    const f = provider(withEnvelope(), (messages, page, _pass, capacity) => {
      if (capacity !== 5000) return;
      if (page === 1 && fault === 'missing') messages.records.pop();
      if (page === 1 && fault === 'repeated') messages.records[100] = messages.records[0];
      if (page === 2 && fault === 'wrong-current') messages.currentPage = 1;
      if (page === 2 && fault === 'changed-total') messages.total++;
      if (page === 2 && fault === 'changed-pages') messages.pages++;
      if (page === 2 && fault === 'not-exhausted') messages.records = [row(0)];
    });
    await expect(f.source.mediaExact({ ...lookup, purpose: 'serve' })).rejects.toThrow(/HISTORY_(PAGINATION|UNSTABLE)/);
    expect(f.fetch.mock.calls.some(([url]) => String(url).includes('getBase64'))).toBe(false);
  });
  it.each(['records-cap', 'pages-cap', 'changed-total'] as const)('rejects a silently capped full batch: %s', async fault => {
    const f = provider(withEnvelope(), (messages, page, _pass, capacity) => {
      if (page !== 1 || capacity !== 5000) return;
      messages.records = messages.records.slice(0, 100);
      if (fault === 'pages-cap') messages.pages = 5;
      if (fault === 'changed-total') messages.total = 100;
    });
    await expect(f.source.mediaExact({ ...lookup, purpose: 'serve' })).rejects.toThrow(/HISTORY_(PAGINATION|UNSTABLE)/);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.fetch.mock.calls.some(([url]) => String(url).includes('getBase64'))).toBe(false);
  });
  it.each([100, 101, 5000])('retains complete physical proof at the %i-row boundary', async total => {
    const rows = Array.from({ length: total }, (_, index) => ({ ...row(index ? 1000 + index : 150), id: `boundary-${index}` }));
    const f = provider(rows);
    expect(await f.source.findMessageExact(lookup)).toEqual({ kind: 'resolved', record: native() });
    const queries = f.fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(queries.map(q => [q.page, q.offset])).toEqual(total === 100 ? [[1, 100], [2, 100], [1, 100], [2, 100]]
      : [[1, 100], [1, 5000], [2, 5000], [1, 5000], [2, 5000]]);
    expect(queries.every(q => isDeepStrictEqual(q.where, { key: { id } }))).toBe(true);
  });
  it('rejects discovery above 5000 without requesting a batch or media', async () => {
    const f = provider(Array.from({ length: 5001 }, (_, index) => row(index)));
    await expect(f.source.mediaExact({ ...lookup, purpose: 'serve' })).rejects.toThrow('HISTORY_PAGE_LIMIT');
    expect(f.fetch).toHaveBeenCalledOnce();
  });
  it('rejects missing physical row identity and incomplete totals in the paginated fallback', async () => {
    for (const change of [(messages: any) => { delete messages.records[0].id; }, (messages: any) => { delete messages.total; }]) {
      const f = provider(withEnvelope(), (messages, page) => { if (page === 1) change(messages); });
      expect(await f.source.findMessageExact(lookup)).toEqual({ kind: 'ambiguous' });
    }
  });
  it('requires convergence of every physical row, including unrelated recipients', async () => {
    const f = provider(broadcast(), (messages, page, pass) => {
      if (page === 1) messages.records[0] = { ...messages.records[0], message: { conversation: `pass-${pass}` } };
    });
    await expect(f.source.findMessageExact(lookup)).rejects.toThrow('HISTORY_UNSTABLE');
    expect(f.fetch).toHaveBeenCalledTimes(7);
  });
  it('can converge on the third pass after one bounded change', async () => {
    const f = provider(broadcast(), (messages, page, pass) => {
      if (page === 1) messages.records[0] = { ...messages.records[0], message: { conversation: pass ? 'settled' : 'old' } };
    });
    expect(await f.source.findMessageExact(lookup)).toEqual({ kind: 'resolved', record: native() });
    expect(f.fetch).toHaveBeenCalledTimes(7);
  });
  it('bounds physical-row metadata within the complete batch before claiming completeness', async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const { page, offset } = JSON.parse(String(init?.body));
      return Response.json({ messages: { pages: Math.ceil(5000 / offset), total: 5000, currentPage: page,
        records: Array.from({ length: Math.min(offset, Math.max(0, 5000 - (page - 1) * offset)) }, (_, n) => ({ ...row(n), id: `${page}-${n}-${'x'.repeat(2300)}` })) } });
    });
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'synthetic', fetch });
    await expect(source.findMessageExact(lookup)).rejects.toMatchObject({ code: 'HISTORY_SCAN_LIMIT' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects an excessive page count or oversized response before media I/O', async () => {
    const tooMany = provider(broadcast(), messages => { messages.pages = 51; });
    await expect(tooMany.source.findMessageExact(lookup)).rejects.toThrow('HISTORY_PAGE_LIMIT');
    const fetch = vi.fn(async () => new Response('x'.repeat(16 * 1024 * 1024 + 1)));
    await expect(createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'synthetic', fetch }).findMessageExact(lookup)).rejects.toThrow('HISTORY_RESPONSE_LIMIT');
  });
  it('cancels a stalled response stream when the shared lookup deadline expires', async () => {
    let cancelled = false;
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const { page, offset } = JSON.parse(String(init?.body));
      if (page === 1 && offset === 100) return Response.json({ messages: { pages: 5, total: 408, currentPage: 1, records: broadcast().slice(0, 100) } });
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"messages":')); },
        cancel() { cancelled = true; } }));
    });
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'synthetic', fetch, exactLookupTimeoutMs: 100 });
    await expect(source.findMessageExact(lookup)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(cancelled).toBe(true); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('aborts a real loopback request and never requests media after the deadline', async () => {
    let disconnected!: () => void;
    const closed = new Promise<void>(resolve => { disconnected = resolve; });
    const paths: string[] = [];
    const server = http.createServer((request, response) => {
      paths.push(request.url!);
      response.once('close', disconnected); // Deliberately never send response headers.
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const source = createEvolutionHistorySource({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: 'synthetic', exactLookupTimeoutMs: 1000 });
      await expect(source.mediaExact({ ...lookup, purpose: 'serve' })).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(paths).toEqual(['/chat/findMessages/owned-instance']);
      await closed;
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('also cancels the media body under the same overall deadline after a complete lookup', async () => {
    const f = provider(), original = f.fetch.getMockImplementation()!; let cancelled = false;
    f.fetch.mockImplementation(async (url, init) => {
      if (!String(url).includes('getBase64')) return original(url, init);
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"base64":"')); },
        cancel() { cancelled = true; } }));
    });
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'synthetic', fetch: f.fetch, exactLookupTimeoutMs: 1000 });
    await expect(source.mediaExact({ ...lookup, purpose: 'serve' })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(cancelled).toBe(true); expect(f.fetch).toHaveBeenCalledTimes(6);
  });
});
