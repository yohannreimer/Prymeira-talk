import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { install, context } = require('../../../../../infra/waha-recovery/pagination.cjs');
it('reports raw progress even when every provider row is an omitted protocol event', async () => {
  class Session {
    client = { GetMessages: (_request: unknown, callback: (err: unknown, rows: unknown[]) => void) => callback(null, [{ protocol: true }, { protocol: true }]) };
    async getChatMessages() { return await new Promise(resolve => this.client.GetMessages({}, (_e, rows) => resolve(rows.filter(r => !(r as { protocol: boolean }).protocol)))); }
  }
  install(Session, (rows: unknown) => rows);
  const headers: Record<string, string> = {};
  const result = await context.run({ request: { headers: { 'x-talk-recovery-pagination': '1' } }, response: { setHeader: (k: string, v: string) => { headers[k] = v; } } }, () => (new Session().getChatMessages as Function)('all', { limit: 50, offset: 100 }, { 'filter.timestamp.gte': 1, 'filter.timestamp.lte': 2 }));
  expect(result).toEqual([]);
  expect(headers).toMatchObject({ 'x-talk-recovery-raw-count': '2', 'x-talk-recovery-next-offset': '102', 'x-talk-recovery-exhausted': 'false' });
});
it('keeps concurrent responses isolated and only marks exhaustion on a raw empty page', async () => {
  class Session {
    client = { GetMessages: (n: number, callback: (err: unknown, rows: unknown[]) => void) => setTimeout(() => callback(null, Array.from({ length: n }, () => ({}))), n ? 5 : 0) };
    async getChatMessages(_chat: string, query: { offset: number }) { return await new Promise(resolve => this.client.GetMessages(query.offset, (_e, rows) => resolve(rows))); }
  }
  install(Session, (rows: unknown) => rows);
  const session = new Session();
  const run = async (offset: number) => { const headers: Record<string, string> = {}; await context.run({ request: { headers: { 'x-talk-recovery-pagination': '1' } }, response: { setHeader: (k: string, v: string) => { headers[k] = v; } } }, () => (session.getChatMessages as Function)('all', { limit: 50, offset }, { 'filter.timestamp.gte': 1, 'filter.timestamp.lte': 2 })); return headers; };
  const [a, b] = await Promise.all([run(2), run(0)]);
  expect(a['x-talk-recovery-exhausted']).toBe('false'); expect(b['x-talk-recovery-exhausted']).toBe('true');
});
