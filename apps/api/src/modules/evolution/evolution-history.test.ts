import { describe, it, expect, vi } from 'vitest';
import { createEvolutionHistorySource } from './evolution-history.js';

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
describe('read-only Evolution history', () => {
  it('loads one exact provider message to recover its edit secret', async () => {
    const { source, fetchMock } = setup();
    const result = await source.findMessage({ instanceName: 'Diogo', id: 'anchor' });
    expect(result?.key.id).toBe('anchor');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1].body))).toEqual({
      where: { key: { id: 'anchor' } }, page: 1, offset: 10
    });
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
      return new Response(JSON.stringify({ messages: { records: [row('new', end.getTime()), row('old')] } }));
    });
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'test', fetch: fetchMock as typeof fetch });
    const chats = await source.recentChats({ instanceName: 'New', limit: 50 });
    expect(chats).toHaveLength(50);
    expect(chats[0]?.remoteJid).toBe('60@s.whatsapp.net');
    expect(chats.at(-1)?.remoteJid).toBe('109@s.whatsapp.net');
    expect((await source.recentMessages({ instanceName: 'New', remoteJid: jid, limit: 20 })).map(r => r.key.id)).toEqual(['old', 'new']);
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
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'test', fetch: fetchMock });
    await expect(source.recentChats({ instanceName: 'New', limit: 50 })).resolves.toEqual([
      { remoteJid: '987654@lid', phoneJid: jid, pushName: 'Cliente', profilePicUrl: null }
    ]);
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

  it('does not mistake LID identifiers for telephone numbers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([{ remoteJid: '987654@lid' }])));
    const source = createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'test', fetch: fetchMock });
    await expect(source.recentChats({ instanceName: 'New', limit: 50 })).rejects.toThrow('HISTORY_LID_UNRESOLVED');
  });
});
