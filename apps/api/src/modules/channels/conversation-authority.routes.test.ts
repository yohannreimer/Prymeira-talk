import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ list: vi.fn(), resolve: vi.fn() }));
vi.mock('./conversation-authority.js', () => ({ listAuthorityReviews: mocks.list, resolveConversationAuthority: mocks.resolve }));
const { conversationAuthorityRoutes } = await import('./conversation-authority.routes.js');

const chatId = '00000000-0000-4000-8000-000000000001', conversationId = '00000000-0000-4000-8000-000000000002', channelId = '00000000-0000-4000-8000-000000000003';
async function build(role: 'owner' | 'manager' | 'agent', onResolved = vi.fn()) {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async request => { request.talk = { workspaceId: 'w', role, clerkUserId: 'user_1' }; });
  const db = { canonicalChat: { findFirst: vi.fn(async ({ where }: { where: { id: string } }) => where.id === chatId ? { channelId } : null) } };
  await app.register(conversationAuthorityRoutes, { db: db as never, onResolved });
  return { app, onResolved };
}

describe('conversation authority routes', () => {
  beforeEach(() => { mocks.list.mockReset(); mocks.resolve.mockReset(); });
  it('is forbidden for agents on both routes', async () => {
    const { app } = await build('agent');
    expect((await app.inject({ method: 'GET', url: '/channels/conversation-authority' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/channels/conversation-authority/${chatId}/resolve`, payload: { conversationId } })).statusCode).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it('lists for the caller workspace and resolves with the actor recorded, then announces both conversations', async () => {
    mocks.list.mockResolvedValue([]);
    mocks.resolve.mockResolvedValue({ ok: true, operationConversationId: conversationId, retiredConversationIds: ['retired'], recovered: 2 });
    const { app, onResolved } = await build('manager');
    expect((await app.inject({ method: 'GET', url: '/channels/conversation-authority' })).json()).toEqual({ items: [] });
    expect(mocks.list).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'w', limit: 50 });
    const response = await app.inject({ method: 'POST', url: `/channels/conversation-authority/${chatId}/resolve`, payload: { conversationId } });
    expect(response.json()).toEqual({ ok: true, operationConversationId: conversationId, recovered: 2 });
    expect(mocks.resolve).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'w', channelId, chatId, conversationId, resolvedBy: 'user_1' });
    expect(onResolved).toHaveBeenCalledWith('w', [conversationId, 'retired']);
  });
  it('answers refusals with a readable 409 and unknown chats with 404, validating input first', async () => {
    mocks.resolve.mockResolvedValue({ ok: false, reason: 'send_outcome_unknown' });
    const { app } = await build('owner');
    const refused = await app.inject({ method: 'POST', url: `/channels/conversation-authority/${chatId}/resolve`, payload: { conversationId } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ reason: 'send_outcome_unknown', error: expect.stringContaining('Envios em revisão') });
    expect((await app.inject({ method: 'POST', url: `/channels/conversation-authority/00000000-0000-4000-8000-0000000000ff/resolve`, payload: { conversationId } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/channels/conversation-authority/${chatId}/resolve`, payload: { conversationId: 'nope' } })).statusCode).toBe(400);
  });
});
