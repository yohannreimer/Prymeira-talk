import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ compare: vi.fn(), failing: false }));
// A plain function (not the spy) produces the rejection, so the spy never holds an unawaited rejected result.
vi.mock('./provider-history.js', () => ({ compareProviderHistories: async (...args: unknown[]) => { mocks.compare(...args); if (mocks.failing) throw new Error('down'); return mocks.compare.mock.results.at(-1)?.value; } }));
const { historyComparisonRoutes } = await import('./history-comparison.routes.js');

const channelId = '00000000-0000-4000-8000-000000000003';
async function build(role: 'owner' | 'manager' | 'agent', connections: Array<{ provider: string; sessionName: string }>, deps = { evolution: {}, waha: {} }) {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async request => { request.talk = { workspaceId: 'w', role, clerkUserId: 'u' }; });
  const db = { channelConnection: { findMany: vi.fn(async () => connections) } };
  await app.register(historyComparisonRoutes, { db: db as never, deps: deps as never });
  return { app, db };
}
const both = [{ provider: 'evolution', sessionName: 'evo' }, { provider: 'waha', sessionName: 'wa' }];

describe('history comparison route', () => {
  beforeEach(() => { mocks.compare.mockReset(); mocks.failing = false; });
  it('is for owners and managers only', async () => {
    const { app } = await build('agent', both);
    expect((await app.inject({ method: 'GET', url: `/channels/${channelId}/history-comparison` })).statusCode).toBe(403);
    expect(mocks.compare).not.toHaveBeenCalled();
  });
  it('compares the two connected sessions of the caller workspace channel', async () => {
    mocks.compare.mockReturnValue({ chats: [], skippedLidChats: 0, totals: { evolution: 0, waha: 0, onlyEvolution: 0, onlyWaha: 0, both: 0 } });
    const { app, db } = await build('manager', both);
    const response = await app.inject({ method: 'GET', url: `/channels/${channelId}/history-comparison?chats=5` });
    expect(response.statusCode).toBe(200);
    expect(db.channelConnection.findMany).toHaveBeenCalledWith({ where: { workspaceId: 'w', channelId, status: 'connected' } });
    expect(mocks.compare).toHaveBeenCalledWith(expect.anything(), { evolutionSession: 'evo', wahaSession: 'wa', chatLimit: 5 });
  });
  it('needs both connections, both providers configured, and reports a provider failure', async () => {
    expect((await (await build('owner', [both[0]!])).app.inject({ method: 'GET', url: `/channels/${channelId}/history-comparison` })).statusCode).toBe(409);
    expect((await (await build('owner', both, { evolution: {}, waha: null } as never)).app.inject({ method: 'GET', url: `/channels/${channelId}/history-comparison` })).statusCode).toBe(409);
    mocks.failing = true;
    const failing = await (await build('owner', both)).app.inject({ method: 'GET', url: `/channels/${channelId}/history-comparison` });
    expect({ status: failing.statusCode, body: failing.json() }).toEqual({ status: 502, body: { error: expect.stringContaining('não respondeu') } });
  });
});
