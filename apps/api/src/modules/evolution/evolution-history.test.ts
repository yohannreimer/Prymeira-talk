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
