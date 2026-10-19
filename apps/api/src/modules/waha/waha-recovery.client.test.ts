import { expect, it, vi } from 'vitest';
import { createWahaClient } from './waha.client.js';

it('reads only a fixed GOWS timestamp interval across all chats without media downloads', async () => {
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/api/server/version') ? { engine: 'GOWS', version: '2026.9.1' } : []), { headers: { 'x-talk-recovery-pagination': '1', 'x-talk-recovery-raw-digest': 'a'.repeat(64), 'x-talk-recovery-raw-count': '0', 'x-talk-recovery-next-offset': '50', 'x-talk-recovery-exhausted': 'true' } }));
  const client = createWahaClient({ baseUrl: 'https://waha.example', apiKey: 'fixture', fetch: fetch as never });
  await client.getRecoveryMessages({ session: 'fixture', from: 1700000000, to: 1700000300, offset: 50, limit: 50 });
  const request = new URL(fetch.mock.calls.at(-1)![0]);
  expect(request.pathname).toBe('/api/fixture/chats/all/messages');
  expect(Object.fromEntries(request.searchParams)).toEqual({ limit: '50', offset: '50', downloadMedia: 'false', sortBy: 'timestamp', sortOrder: 'asc', 'filter.timestamp.gte': '1700000000', 'filter.timestamp.lte': '1700000300' });
});
it('does not fall back to an exhaustive scan on an unsupported engine', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ engine: 'WPP' })));
  const client = createWahaClient({ baseUrl: 'https://waha.example', apiKey: 'fixture', fetch: fetch as never });
  await expect(client.getRecoveryMessages({ session: 'fixture', from: 1, to: 2, offset: 0, limit: 50 })).rejects.toThrow('HISTORY_FILTER_UNSUPPORTED');
  expect(fetch).toHaveBeenCalledOnce();
});

it('refuses to certify a provider without raw exhaustion metadata', async () => {
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/api/server/version') ? { engine: 'GOWS' } : [])));
  const client = createWahaClient({ baseUrl: 'https://waha.example', apiKey: 'fixture', fetch: fetch as never });
  await expect(client.getRecoveryMessages({ session: 'fixture', from: 1, to: 2, offset: 0, limit: 50 })).rejects.toThrow('HISTORY_PAGINATION_UNSUPPORTED');
});
