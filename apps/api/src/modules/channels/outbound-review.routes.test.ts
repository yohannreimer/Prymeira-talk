import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { outboundReviewRoutes } from './outbound-review.routes.js';

async function build(role: 'owner' | 'manager' | 'agent', journal: Record<string, unknown>) {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async request => { request.talk = { workspaceId: 'w', role, clerkUserId: 'user_1' }; });
  await app.register(outboundReviewRoutes, { journal: journal as never });
  return app;
}
const id = '00000000-0000-4000-8000-000000000001';

describe('outbound review routes', () => {
  it('lists uncertain sends for managers without exposing internal fields', async () => {
    const listForReview = vi.fn(async () => [{ id, channelId: 'c', kind: 'text', destination: '5547', preview: 'oi', errorCode: 'TimeoutError', createdAt: new Date('2026-10-02T12:00:00Z'), attempts: [{ secret: 1 }], connectionId: 'x' }]);
    const app = await build('manager', { listForReview });
    const response = await app.inject({ method: 'GET', url: '/channels/outbound-review' });
    expect(response.json()).toEqual({ items: [{ id, channelId: 'c', kind: 'text', destination: '5547', preview: 'oi', errorCode: 'TimeoutError', createdAt: '2026-10-02T12:00:00.000Z' }] });
    expect(listForReview).toHaveBeenCalledWith({ workspaceId: 'w', limit: 100 });
    await app.close();
  });

  it('is forbidden for agents on both routes', async () => {
    const journal = { listForReview: vi.fn(), resolve: vi.fn() };
    const app = await build('agent', journal);
    expect((await app.inject({ method: 'GET', url: '/channels/outbound-review' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/channels/outbound-review/${id}/resolve`, payload: { delivered: true } })).statusCode).toBe(403);
    expect(journal.listForReview).not.toHaveBeenCalled();
    expect(journal.resolve).not.toHaveBeenCalled();
    await app.close();
  });

  it('records who resolved it and what they found, and reports an already resolved send as not found', async () => {
    const resolve = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const app = await build('owner', { resolve });
    const url = `/channels/outbound-review/${id}/resolve`;
    expect((await app.inject({ method: 'POST', url, payload: { delivered: false } })).json()).toEqual({ ok: true });
    expect(resolve).toHaveBeenCalledWith({ workspaceId: 'w', id, delivered: false, by: 'user_1' });
    expect((await app.inject({ method: 'POST', url, payload: { delivered: false } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/channels/outbound-review/not-a-uuid/resolve', payload: { delivered: true } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url, payload: { delivered: 'yes' } })).statusCode).toBe(400);
    await app.close();
  });
});
