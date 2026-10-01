import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { channelsRoutes } from './channels.routes.js';
const id = '00000000-0000-4000-8000-000000000001';
const connectionId = '00000000-0000-4000-8000-000000000002';
describe('physical connection API scope', () => {
  it('exposes authenticated workspace-scoped redundancy and physical status without changing Meta QR behavior', async () => {
    const app = Fastify();
    const channel = { id, workspaceId: 'ws', provider: 'meta_cloud', providerKey: 'meta', phoneNumber: null, displayName: 'Official', status: 'connected', createdAt: new Date(), updatedAt: new Date() };
    const findFirst = vi.fn(async () => channel);
    app.decorate('prisma', { channel: { findFirst }, channelConnection: { findFirst: vi.fn() } } as any);
    app.decorate('realtime', { publish: vi.fn() } as any);
    app.addHook('onRequest', async (request) => { request.talk = { workspaceId: 'ws', clerkUserId: 'u', role: 'owner' } as any; });
    await app.register(channelsRoutes, { waha: { enabled: false, client: null } });
    const enabled = await app.inject({ method: 'PATCH', url: `/channels/${id}/redundancy`, payload: { enabled: true } });
    expect(enabled.statusCode).toBe(400); expect(enabled.json().code).toBe('CHANNEL_PROVIDER_UNSUPPORTED');
    expect(findFirst).toHaveBeenCalledWith({ where: { workspaceId: 'ws', id } });
    const state = await app.inject({ method: 'GET', url: `/channels/${id}/connections/${connectionId}/state` });
    expect(state.statusCode).toBe(400); expect(state.json().code).toBe('CHANNEL_PROVIDER_UNSUPPORTED');
    const legacy = await app.inject({ method: 'POST', url: `/channels/${id}/qr` });
    expect(legacy.statusCode).toBe(400); expect(legacy.json().code).toBe('CHANNEL_PROVIDER_UNSUPPORTED');
    await app.close();
  });
});
