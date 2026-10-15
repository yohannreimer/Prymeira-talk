import { describe, it, expect, vi } from 'vitest';
import { createEvolutionHistorySource } from './evolution-history.js';
import { fullProviderKeyMatches } from '../messaging/provider-exact.js';
import type { WhatsAppMessageKey } from '../messaging/whatsapp-identity.js';
import { createExactEvolutionMediaFixture } from '../../test/evolution-media-fixture.js';
import type { AddressInfo } from 'node:net';

const jid = '123456789@s.whatsapp.net';
const end = new Date('2026-09-14T12:00:00Z');
const from = new Date(end.getTime() - 30 * 86400000);
const row = (id: string, ms = end.getTime() - 1000, remoteJid = jid) => ({ key: { id, remoteJid, fromMe: false }, messageTimestamp: ms / 1000, message: { conversation: id } });
function setup(passes: unknown[][] = [[row('old'), row('anchor', end.getTime())]]) {
  let pass = 0;
  const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const records = body.where.key.id ? [row('anchor', end.getTime())] : passes[Math.min(pass++, passes.length - 1)];
    return new Response(JSON.stringify({ messages: { total: records.length, pages: 1, currentPage: 1, records } }));
  });
  return { fetchMock, source: createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'test', fetch: fetchMock as typeof fetch }) };
}
const input = { instanceName: 'Diogo', anchorId: 'anchor', from, to: end };
describe('exact Evolution PN/LID rebound', () => {
  const pn = '15550001111@s.whatsapp.net', lid = '700001@lid', group = '120000-100@g.us';
  const expected: WhatsAppMessageKey = { identityFormat: 'whatsapp_stanza', nativeId: 'NATIVE', rawId: 'NATIVE', nativeChatAddress: pn,
    chatAddress: pn, nativeSenderParticipant: null, senderParticipant: '', direction: 'inbound' };
  const native = { ...row('NATIVE', end.getTime(), lid), key: { id: 'NATIVE', remoteJid: lid, remoteJidAlt: pn, fromMe: false } };
  function exact(records: unknown[], metadata: { pages?: number; total?: number } = {}) {
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).includes('getBase64')) return Response.json({ base64: 'YQ==', mimetype: 'image/png' });
      // Faithful failing production contract: the provider stores LID; a PN filter misses it.
      return Response.json({ messages: { records: body.where.key.remoteJid ? [] : records, pages: 1, ...metadata } });
    });
    return { fetch, source: createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'fixture-key', fetch }) };
  }
  it('resolves a requested PN against its explicit native LID and passes the original key to media I/O', async () => {
    const { source, fetch } = exact([native]), keyBefore = { ...expected };
    expect(await source.mediaExact({ instanceName: 'owned-instance', key: expected, purpose: 'serve' })).toEqual({ kind: 'resolved', record: native, mediaUrl: 'data:image/png;base64,YQ==' });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ where: { key: { id: 'NATIVE' } }, page: 1, offset: 100 });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://evolution.invalid/chat/findMessages/owned-instance', 'https://evolution.invalid/chat/getBase64FromMediaMessage/owned-instance']);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).message.key).toEqual(native.key);
    expect(expected).toEqual(keyBefore);
    expect(fullProviderKeyMatches(expected, { ...expected, nativeChatAddress: lid, chatAddress: lid }, { chat: pn })).toBe(false);
  });
  it('also requires explicit proof when the requested native LID is stored as PN', async () => {
    const key = { ...expected, nativeChatAddress: lid }, item = { ...native, key: { ...native.key, remoteJid: pn, remoteJidAlt: lid } };
    expect(await exact([item]).source.findMessageExact({ instanceName: 'owned-instance', key })).toEqual({ kind: 'resolved', record: item });
  });
  it('keeps the real EvolutionClient and loopback provider fixture on the exact ID/native media contract', async () => {
    const provider = createExactEvolutionMediaFixture({ sessionName: 'owned-instance', key: native.key, bytes: Buffer.from('a') });
    await new Promise<void>(resolve => provider.server.listen(0, '127.0.0.1', resolve));
    try {
      const { createEvolutionClient } = await import('./evolution.client.js');
      const client = createEvolutionClient({ baseUrl: `http://127.0.0.1:${(provider.server.address() as AddressInfo).port}`, apiKey: 'test-only' });
      expect(await client.fetchMedia!({ instanceName: 'owned-instance', id: 'NATIVE', key: expected })).toBe('data:image/png;base64,YQ==');
      expect(provider.keys).toEqual([{ id: 'NATIVE' }, native.key]);
    } finally { await new Promise<void>(resolve => provider.server.close(() => resolve())); }
  });
  it('rebinds a group sender only through the record participantAlt', async () => {
    const key = { ...expected, nativeChatAddress: group, chatAddress: group, nativeSenderParticipant: pn, senderParticipant: pn };
    const item = { ...native, key: { id: 'NATIVE', remoteJid: group, fromMe: false, participant: lid, participantAlt: pn } };
    const { source, fetch } = exact([item]);
    expect(await source.mediaExact({ instanceName: 'owned-instance', key, purpose: 'serve' })).toMatchObject({ kind: 'resolved', record: item });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).message.key).toEqual(item.key);
  });
  it.each([
    { label: 'missing pair', key: { ...native.key, remoteJidAlt: undefined } },
    { label: 'unrelated pair', key: { ...native.key, remoteJidAlt: '15550002222@s.whatsapp.net' } },
    { label: 'other id', key: { ...native.key, id: 'FOREIGN' } },
    { label: 'other direction', key: { ...native.key, fromMe: true } },
    { label: 'different group', key: { ...native.key, remoteJid: '120000-200@g.us' } },
    { label: 'direct sender contamination', key: { ...native.key, participant: pn, participantAlt: lid } },
    { label: 'same digits in unrelated PN namespace', key: { ...native.key, remoteJid: '15550002222@s.whatsapp.net', remoteJidAlt: pn } }
  ])('rejects $label before media I/O', async ({ key }) => {
    const { source, fetch } = exact([{ ...native, key }]);
    expect(await source.mediaExact({ instanceName: 'owned-instance', key: expected, purpose: 'serve' })).toEqual({ kind: 'missing' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([{ identityFormat: 'provider_native' as const, rawId: null }, { rawId: 'OTHER' }, { chatAddress: '15550002222@s.whatsapp.net' }])('keeps other expected key fields exact: %j', async changed => {
    expect(await exact([native]).source.findMessageExact({ instanceName: 'owned-instance', key: { ...expected, ...changed } })).toEqual({ kind: 'missing' });
  });
  it.each([undefined, '15550002222@s.whatsapp.net'])('does not rebind a group sender with participantAlt=%s', async participantAlt => {
    const key = { ...expected, nativeChatAddress: group, chatAddress: group, nativeSenderParticipant: pn, senderParticipant: pn };
    const item = { ...native, key: { id: 'NATIVE', remoteJid: group, fromMe: false, participant: lid, participantAlt } };
    expect(await exact([item]).source.findMessageExact({ instanceName: 'owned-instance', key })).toEqual({ kind: 'missing' });
  });
  it('preserves contradictory group-sender evidence as ambiguous after a valid rebound', async () => {
    const key = { ...expected, nativeChatAddress: group, chatAddress: group, nativeSenderParticipant: pn, senderParticipant: pn };
    const item = { ...native, key: { id: 'NATIVE', remoteJid: group, fromMe: false, participant: lid, participantAlt: pn }, participant: '15550002222@s.whatsapp.net' };
    expect(await exact([item]).source.findMessageExact({ instanceName: 'owned-instance', key })).toEqual({ kind: 'ambiguous' });
  });
  it('rejects multiple alias candidates and incomplete pagination before requesting bytes', async () => {
    for (const fixture of [exact([native, { ...native, key: { ...native.key, remoteJid: '700002@lid' } }]), exact([native], { pages: 2 }), exact([native], { total: 2 })]) {
      expect(await fixture.source.mediaExact({ instanceName: 'owned-instance', key: expected, purpose: 'serve' })).toEqual({ kind: 'ambiguous' });
      expect(fixture.fetch).toHaveBeenCalledOnce();
    }
  });
  it('rejects invalid native timestamps before requesting media', async () => {
    for (const messageTimestamp of [0, null, 'invalid']) {
      const { source, fetch } = exact([{ ...native, messageTimestamp }]);
      await expect(source.mediaExact({ instanceName: 'owned-instance', key: expected, purpose: 'serve' })).rejects.toThrow('HISTORY_RECORD');
      expect(fetch).toHaveBeenCalledOnce();
    }
  });
});
describe('read-only Evolution history', () => {
  it('accepts byte-equivalent duplicate history rows, but never conflicting messages or identities', async () => {
    const original = row('anchor');
    const sourceFor = (records: unknown[]) => createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'test',
      fetch: vi.fn(async () => new Response(JSON.stringify({ messages: { records, pages: 1 } }))) });
    const lookup = { instanceName: 'Diogo', id: 'anchor' };
    expect((await sourceFor([original, { ...original, databaseOnlyId: 'copy' }]).findMessage(lookup))?.key.id).toBe('anchor');
    await expect(sourceFor([original, { ...original, message: { conversation: 'conflict' } }]).findMessage(lookup)).rejects.toThrow('HISTORY_DUPLICATE_MESSAGE');
    await expect(sourceFor([original, row('anchor', end.getTime() - 1000, '999@s.whatsapp.net')]).findMessage(lookup)).rejects.toThrow('HISTORY_DUPLICATE_MESSAGE');
    await expect(sourceFor([original, { ...original, key: { ...original.key, fromMe: true } }]).findMessage(lookup)).rejects.toThrow('HISTORY_DUPLICATE_MESSAGE');
  });
  it('loads one exact provider message to recover its edit secret', async () => {
    const { source, fetchMock } = setup();
    const result = await source.findMessage({ instanceName: 'Diogo', id: 'anchor' });
    expect(result?.key.id).toBe('anchor');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1].body))).toEqual({
      where: { key: { id: 'anchor' } }, page: 1, offset: 10
    });
  });
  it('loads an exact group message for repair without enabling bulk group history', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: {
      records: [row('group-1', end.getTime(), '123456-789@g.us')], pages: 1
    } })));
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'key', fetch: fetchMock });
    expect((await source.findMessage({ instanceName: 'Diogo', id: 'group-1' }))?.key.remoteJid).toBe('123456-789@g.us');
  });
  it('uses exact anchor identity, fixed window, deduplicates and orders chronologically', async () => {
    const { source, fetchMock } = setup([[row('future', end.getTime()+1000), row('old'), row('old'), row('too-old', from.getTime()-1000), row('anchor', end.getTime())]]);
    const result = await source.load(input);
    expect(result.map(r => r.key.id)).toEqual(['old', 'anchor']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetchMock.mock.calls) { expect(url).toBe('https://evolution.invalid/chat/findMessages/Diogo'); expect(init.method).toBe('POST'); }
  });
  it('rejects a response belonging to another contact', async () => {
    await expect(setup([[row('other', end.getTime()-1000, '999@g.us')]]).source.load(input)).rejects.toThrow('HISTORY_IDENTITY');
  });
  it('rejects unstable pagination rather than claiming a complete import', async () => {
    await expect(setup([[row('a')], [row('b')], [row('c')]]).source.load(input)).rejects.toThrow('HISTORY_UNSTABLE');
  });
  it('requires the exact anchor and validates response shape', async () => {
    const source = createEvolutionHistorySource({ baseUrl:'https://evolution.invalid', apiKey:'test', fetch:vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages:{records:[row('wrong')],pages:1,total:1} }))) });
    await expect(source.load(input)).rejects.toThrow('HISTORY_ANCHOR');
  });
  it('does not return provider secrets or raw errors', async () => {
    const source = createEvolutionHistorySource({ baseUrl:'https://evolution.invalid', apiKey:'test', fetch:vi.fn().mockResolvedValue(new Response('private body', {status:500})) });
    await expect(source.load(input)).rejects.toThrow('HISTORY_HTTP_500');
  });
  it('rejects invalid timestamps, pagination limits and changed duplicate records', async () => {
    await expect(setup([[row('broken', NaN)]]).source.load(input)).rejects.toThrow('HISTORY_RECORD');
    await expect(setup([[row('old'), {...row('old'),message:{conversation:'changed'}}]]).source.load(input)).rejects.toThrow('HISTORY_CONFLICT');
  });
  it('fetches every page in both convergence passes', async () => {
    const fetchMock = vi.fn(async (_url:unknown, init:RequestInit) => {
      const b=JSON.parse(String(init.body));
      const records=b.where.key.id ? [row('anchor',end.getTime())] : b.page===1 ? [row('old')] : [row('anchor',end.getTime())];
      return new Response(JSON.stringify({messages:{total:b.where.key.id?1:2,pages:b.where.key.id?1:2,records}}));
    });
    const source=createEvolutionHistorySource({baseUrl:'https://evolution.invalid',apiKey:'test',fetch:fetchMock as typeof fetch});
    expect((await source.load(input)).map(r=>r.key.id)).toEqual(['old','anchor']);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
  it('fails on excessive page counts before reading arbitrary volumes', async () => {
    const fetchMock=vi.fn(async()=>new Response(JSON.stringify({messages:{pages:51,records:[]}})));
    await expect(createEvolutionHistorySource({baseUrl:'https://evolution.invalid',apiKey:'test',fetch:fetchMock}).load(input)).rejects.toThrow('HISTORY_PAGE_LIMIT');
  });
});

describe('hasPriorMessages', () => {
  const current = 'current-message';

  it('reports prior history when any other message exists', async () => {
    const { source } = setup([[row('old'), row(current, end.getTime())]]);
    await expect(source.hasPriorMessages({ instanceName: 'Diogo', remoteJid: jid, excludeMessageId: current })).resolves.toBe(true);
  });

  it('ignores only the current message', async () => {
    const { source } = setup([[row(current, end.getTime())]]);
    await expect(source.hasPriorMessages({ instanceName: 'Diogo', remoteJid: jid, excludeMessageId: current })).resolves.toBe(false);
    await expect(source.hasPriorMessages({ instanceName: 'Diogo', remoteJid: jid })).resolves.toBe(true);
  });

  it('does not mistake later messages in the same new conversation for older history', async () => {
    const { source } = setup([[row(current, end.getTime()), row('later', end.getTime() + 60_000)]]);
    await expect(source.hasPriorMessages({ instanceName: 'Diogo', remoteJid: jid, excludeMessageId: current, before: end })).resolves.toBe(false);
    const { source: withHistory } = setup([[row('old', end.getTime() - 60_000), row(current, end.getTime()), row('later', end.getTime() + 60_000)]]);
    await expect(withHistory.hasPriorMessages({ instanceName: 'Diogo', remoteJid: jid, excludeMessageId: current, before: end })).resolves.toBe(true);
  });

  it('treats malformed records as prior history instead of guessing', async () => {
    const { source } = setup([[{ key: { remoteJid: jid } }]]);
    await expect(source.hasPriorMessages({ instanceName: 'Diogo', remoteJid: jid, excludeMessageId: current })).resolves.toBe(true);
  });

  it('rejects non-direct identities before querying', async () => {
    const { source, fetchMock } = setup();
    await expect(source.hasPriorMessages({ instanceName: 'Diogo', remoteJid: '999@g.us' })).rejects.toThrow('HISTORY_IDENTITY');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('new channel history', () => {
  it('reads a full chat batch when small pages overlap', async () => {
    const full = Array.from({ length: 150 }, (_, index) => ({ remoteJid: `${index + 1000}@s.whatsapp.net` }));
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      const { take, skip } = JSON.parse(String(init.body)) as { take: number; skip: number };
      return new Response(JSON.stringify(take === 1000 ? full : skip === 0 ? full.slice(0, 100) : full.slice(0, 10)));
    });
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'test', fetch: fetchMock as typeof fetch });
    const result = await source.recentChats({ instanceName: 'New', limit: 1000 });
    expect(result.chats).toHaveLength(150);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1].body))).toEqual({ take: 1000, skip: 0 });
  });

  it('pages recent chats, skips groups, and reads 20 messages in chronological order', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      remoteJid: index < 60 ? `${index}@g.us` : `${index}@s.whatsapp.net`,
      pushName: `Pessoa ${index}`, profilePicUrl: 'https://example.com/avatar.jpg'
    }));
    const secondPage = Array.from({ length: 10 }, (_, index) => ({ remoteJid: `${index + 100}@s.whatsapp.net` }));
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (url.includes('findChats')) return new Response(JSON.stringify(body.skip ? secondPage : firstPage));
      if (url.includes('findContacts')) return new Response(JSON.stringify([]));
      return new Response(JSON.stringify({ messages: { records: [row('new', end.getTime()), { ...row('old'), pushName: ' Cliente ' }] } }));
    });
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'test', fetch: fetchMock as typeof fetch });
    const { chats, unresolvedLids } = await source.recentChats({ instanceName: 'New', limit: 50 });
    expect(chats).toHaveLength(50);
    expect(unresolvedLids).toBe(0);
    expect(chats[0]?.remoteJid).toBe('60@s.whatsapp.net');
    expect(chats.at(-1)?.remoteJid).toBe('109@s.whatsapp.net');
    const messages = await source.recentMessages({ instanceName: 'New', remoteJid: jid, limit: 20 });
    expect(messages.map(r => r.key.id)).toEqual(['old', 'new']);
    expect(messages[0]?.pushName).toBe('Cliente');
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1].body))).toEqual({ where: { key: { remoteJid: jid } }, page: 1, offset: 20 });
  });

  it('rejects an identity mismatch from the message endpoint', async () => {
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'test',
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: { records: [row('wrong', end.getTime(), '999@s.whatsapp.net')] } }))) });
    await expect(source.recentMessages({ instanceName: 'New', remoteJid: jid, limit: 20 })).rejects.toThrow('HISTORY_IDENTITY');
  });

  it('uses a phone alternate for LID chats and deduplicates the same contact', async () => {
    const fetchMock = vi.fn(async (url: unknown) => new Response(JSON.stringify(String(url).includes('findContacts') ? [] : [
      { remoteJid: '987654@lid', remoteJidAlt: jid, pushName: 'Cliente' },
      { remoteJid: jid, pushName: 'Cliente' }
    ])));
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'test', fetch: fetchMock as typeof fetch });
    await expect(source.recentChats({ instanceName: 'New', limit: 50 })).resolves.toEqual({ chats: [
      { remoteJid: '987654@lid', phoneJid: jid, pushName: 'Cliente', profilePicUrl: null }
    ], unresolvedLids: 0 });
  });

  it('reads saved contact names independently of chat push names', async () => {
    const fetchMock = vi.fn(async (url: unknown) => new Response(JSON.stringify(String(url).includes('findContacts')
      ? [{ remoteJid: jid, pushName: 'Nome salvo' }]
      : [{ remoteJid: jid, pushName: null }])));
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'test', fetch: fetchMock });
    expect(await source.recentContacts({ instanceName: 'New' })).toEqual([
      { phoneJid: jid, name: 'Nome salvo', profilePicUrl: null }
    ]);
  });

  it('never proposes placeholder, phone or WhatsApp-id contact names but keeps real ones', async () => {
    const fetchMock = vi.fn(async (url: unknown) => new Response(JSON.stringify(String(url).includes('findContacts')
      ? [
          { remoteJid: '1001@s.whatsapp.net', pushName: 'Você' },
          { remoteJid: '1002@s.whatsapp.net', pushName: '556392370750' },
          { remoteJid: '1003@s.whatsapp.net', pushName: '103547450441825@lid' },
          { remoteJid: '1004@s.whatsapp.net', pushName: '  Ana   Souza ' }
        ]
      : [])));
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'test', fetch: fetchMock });
    expect(await source.recentContacts({ instanceName: 'New' })).toEqual([
      { phoneJid: '1001@s.whatsapp.net', name: null, profilePicUrl: null },
      { phoneJid: '1002@s.whatsapp.net', name: null, profilePicUrl: null },
      { phoneJid: '1003@s.whatsapp.net', name: null, profilePicUrl: null },
      { phoneJid: '1004@s.whatsapp.net', name: 'Ana Souza', profilePicUrl: null }
    ]);
  });

  it('keeps an earlier real contact name when a later row only has a placeholder', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([
      { remoteJid: jid, pushName: 'Nome salvo' }, { remoteJid: jid, pushName: 'You' }
    ])));
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'test', fetch: fetchMock });
    expect(await source.recentContacts({ instanceName: 'New' })).toEqual([{ phoneJid: jid, name: 'Nome salvo', profilePicUrl: null }]);
  });

  it('does not take a chat name from our own last message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([
      { remoteJid: '2001@s.whatsapp.net', lastMessage: { key: { fromMe: true }, pushName: 'Você' } },
      { remoteJid: '2002@s.whatsapp.net', lastMessage: { key: { fromMe: true }, pushName: 'Marcos' } },
      { remoteJid: '2003@s.whatsapp.net', lastMessage: { pushName: 'Sem chave' } },
      { remoteJid: '2004@s.whatsapp.net', lastMessage: { key: { fromMe: false }, pushName: 'Cliente Real' } },
      { remoteJid: '2005@s.whatsapp.net', pushName: 'Você', lastMessage: { key: { fromMe: false }, pushName: 'Cliente Inbound' } },
      { remoteJid: '2006@s.whatsapp.net', pushName: '556392370750' },
      { remoteJid: '2007@s.whatsapp.net', pushName: '103547450441825@lid' },
      { remoteJid: '2008@s.whatsapp.net', lastMessage: { key: { fromMe: false }, pushName: 'Voce' } }
    ])));
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'test', fetch: fetchMock });
    const { chats } = await source.recentChats({ instanceName: 'New', limit: 50 });
    expect(chats.map((chat) => chat.pushName)).toEqual([null, null, null, 'Cliente Real', 'Cliente Inbound', null, null, null]);
  });

  it('drops placeholder push names from message records', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: { records: [
      { ...row('a', end.getTime() - 2000), pushName: 'Você' }, { ...row('b'), pushName: ' Ana ' }
    ] } })));
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'test', fetch: fetchMock });
    const messages = await source.recentMessages({ instanceName: 'New', remoteJid: jid, limit: 20 });
    expect(messages[0]).not.toHaveProperty('pushName');
    expect(messages[1]?.pushName).toBe('Ana');
  });

  it('retains unresolved LID identities without mistaking them for telephone numbers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([{ remoteJid: '987654@lid' }])));
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'test', fetch: fetchMock });
    await expect(source.recentChats({ instanceName: 'New', limit: 50 })).resolves.toEqual({
      chats: [{ remoteJid: '987654@lid', phoneJid: '987654@lid', pushName: null, profilePicUrl: null }], unresolvedLids: 1
    });
  });

  it('loads older message pages for a conversation without changing their chronological order', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { page: number; offset: number };
      const records = Array.from({ length: body.page === 1 ? 100 : 2 }, (_, index) => ({
        ...row(`page-${body.page}-${index}`, 1_790_000_000_000 + (body.page === 1 ? 100 + index : index) * 1000),
        key: { id: `page-${body.page}-${index}`, remoteJid: jid, fromMe: false }
      }));
      return new Response(JSON.stringify({ messages: { records, pages: 2 } }));
    });
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'test', fetch: fetchMock as typeof fetch });
    const messages = await source.recentMessages({ instanceName: 'New', remoteJid: jid, limit: 500 });
    expect(messages).toHaveLength(102);
    expect(messages[0]?.key.id).toBe('page-2-0');
    expect(messages.at(-1)?.key.id).toBe('page-1-99');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('limits the initial chat list to activity within the requested window', async () => {
    const now = Math.floor(Date.now() / 1000);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([
      { remoteJid: jid, lastMessage: { messageTimestamp: now } },
      { remoteJid: '987654321@lid', lastMessage: { messageTimestamp: now - 20 * 86400 } }
    ])));
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'test', fetch: fetchMock });
    const result = await source.recentChats({ instanceName: 'New', limit: 1000, since: new Date((now - 15 * 86400) * 1000) });
    expect(result.chats.map(chat => chat.remoteJid)).toEqual([jid]);
  });
});

describe('exhausted recovery reads', () => {
  it('bounds projected chat metadata without claiming partial exhaustion', async () => {
    const chats = Array.from({ length: 17 }, (_, i) => ({ remoteJid: `1555000${String(i).padStart(4, '0')}@s.whatsapp.net`, profilePicUrl: `https://fixture.invalid/${'x'.repeat(512 * 1024)}` }));
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => Response.json(JSON.parse(String(init?.body)).skip ? [] : chats));
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'synthetic', fetch });
    await expect(source.recoveryChats({ instanceName: 'fixture', from, to: end })).rejects.toMatchObject({ code: 'HISTORY_SCAN_LIMIT' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('refuses an oversized retained window instead of certifying its prefix', async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body));
      return Response.json({ messages: { records: [{ ...row(String(input.page)), message: { conversation: 'x'.repeat(512 * 1024) } }], pages: 17, total: 17 } });
    });
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'synthetic', fetch });
    await expect(source.recoveryMessages({ instanceName: 'fixture', remoteJid: jid, from, to: end })).rejects.toMatchObject({ code: 'HISTORY_SCAN_LIMIT' });
    expect(fetch.mock.calls.length).toBeLessThan(18);
  });
  it('counts discarded old rows for exhaustion and still rejects their duplicates', async () => {
    const old = row('old', from.getTime() - 1000), recent = row('recent');
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body));
      return Response.json({ messages: { records: input.page === 1 ? [old] : [recent], pages: 2, total: 2 } });
    });
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'synthetic', fetch });
    expect(await source.recoveryMessages({ instanceName: 'fixture', remoteJid: jid, from, to: end })).toEqual([expect.objectContaining({ key: recent.key })]);
    expect(fetch).toHaveBeenCalledTimes(4);
    const duplicate = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'synthetic',
      fetch: vi.fn(async () => Response.json({ messages: { records: [old], pages: 2, total: 2 } })) });
    await expect(duplicate.recoveryMessages({ instanceName: 'fixture', remoteJid: jid, from, to: end })).rejects.toThrow('HISTORY_PAGINATION');
  });
  it('reads more than 200 chats even when the server caps each response at 37', async () => {
    const chats = Array.from({ length: 205 }, (_, i) => ({ remoteJid: `1555000${String(i).padStart(4, '0')}@s.whatsapp.net` }));
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => { const input = JSON.parse(String(init?.body)); return Response.json(chats.slice(input.skip, input.skip + 37)); });
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'synthetic', fetch });
    expect((await source.recoveryChats({ instanceName: 'fixture', from, to: end })).chats).toHaveLength(205);
    expect(fetch).toHaveBeenCalledTimes(14);
  });
  it('reads all message pages under one fixed window before certifying them', async () => {
    const messages = Array.from({ length: 173 }, (_, i) => row(String(i), end.getTime() - i * 1000));
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => { const input = JSON.parse(String(init?.body)); return Response.json({ messages: { records: messages.slice((input.page - 1) * 100, input.page * 100), pages: 2, total: messages.length } }); });
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'synthetic', fetch });
    expect(await source.recoveryMessages({ instanceName: 'fixture', remoteJid: jid, from, to: end })).toHaveLength(173);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it.each([
    { records: [row('a')], total: 2 },
    { records: [row('a')], total: 2, pages: 1 },
    { records: [], total: 2, pages: 2 }
  ])('rejects unknown or truncated message exhaustion: %j', async messages => {
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'synthetic', fetch: vi.fn(async () => Response.json({ messages })) });
    await expect(source.recoveryMessages({ instanceName: 'fixture', remoteJid: jid, from, to: end })).rejects.toThrow(/HISTORY_(SHAPE|PAGINATION)/);
  });
});
