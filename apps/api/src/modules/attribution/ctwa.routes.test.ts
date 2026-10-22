import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../test/build-app.js';
import { ctwaRoutes } from './ctwa.routes.js';
import { CtwaOperationError } from './ctwa-service.js';
const id = '00000000-0000-4000-8000-000000000001';
const headers = { authorization: 'Bearer synthetic-token' };
async function fixture(role: 'owner' | 'manager' | 'agent' = 'owner') {
  const app = await buildApp({ PRYMEIRA_LOCAL_AUTH_BYPASS: true, PRYMEIRA_LOCAL_WORKSPACE_ID: 'synthetic-authorized-workspace', PRYMEIRA_LOCAL_ROLE: role }, { authEnabled: true });
  const service = { list: vi.fn(async () => []), prepare: vi.fn(async () => ({ id, eventId: 'ctwa_synthetic', state: 'pending_validation' })), dispatch: vi.fn(async () => ({ id, state: 'accepted', outcomeCode: 'meta_accepted_not_attribution', responseCode: 200, eventsReceived: 1 })) };
  await app.register(ctwaRoutes, { service });
  return { app, service };
}
describe('authenticated CTWA operator namespace', () => {
  it('rejects unauthenticated access without invoking service', async () => {
    const { app, service } = await fixture();
    try { expect((await app.inject('/attribution/ctwa')).statusCode).toBe(401); expect(service.list).not.toHaveBeenCalled(); } finally { await app.close(); }
  });
  it.each(['manager', 'agent'] as const)('%s cannot prepare or dispatch', async role => {
    const { app, service } = await fixture(role);
    try {
      for (const url of [`/attribution/ctwa/${id}/events`, `/attribution/ctwa/events/${id}/dispatch`]) expect((await app.inject({ method: 'POST', url, headers, payload: { validated: true } })).statusCode).toBe(403);
      const read = await app.inject({ url: '/attribution/ctwa', headers }); expect(read.statusCode).toBe(role === 'manager' ? 200 : 403);
      expect(service.prepare).not.toHaveBeenCalled(); expect(service.dispatch).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('uses authenticated tenant only, bounded filters, strict IDs and explicit review', async () => {
    const { app, service } = await fixture();
    try {
      const read = await app.inject({ url: `/attribution/ctwa?channelId=${id}&limit=10`, headers }); expect(read.statusCode).toBe(200); expect(read.headers['cache-control']).toBe('private, no-store'); expect(service.list).toHaveBeenCalledWith('synthetic-authorized-workspace', { channelId: id, limit: 10 }); expect(service.dispatch).not.toHaveBeenCalled();
      for (const query of ['limit=101', 'limit=0', 'workspaceId=other', 'channelId=bad']) expect((await app.inject({ url: `/attribution/ctwa?${query}`, headers })).statusCode).toBe(400);
      for (const payload of [{ eventName: 'LeadSubmitted' }, { eventName: 'QualifiedLead', workspaceId: 'other' }, { eventName: 'Purchase', orderId: '', value: 1, currency: 'BRL' }, { eventName: 'Purchase', orderId: 'one', value: 0, currency: 'BRL' }, { eventName: 'Purchase', orderId: 'one', value: 1, currency: 'brl' }]) expect((await app.inject({ method: 'POST', url: `/attribution/ctwa/${id}/events`, headers, payload })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: `/attribution/ctwa/${id}/events`, headers, payload: { eventName: 'QualifiedLead' } })).statusCode).toBe(200);
      expect(service.prepare).toHaveBeenCalledWith('synthetic-authorized-workspace', id, 'QualifiedLead', undefined);
      expect((await app.inject({ method: 'POST', url: `/attribution/ctwa/${id}/events`, headers, payload: { eventName: 'Purchase', orderId: 'order-1', value: 2.95, currency: 'BRL' } })).statusCode).toBe(200);
      for (const payload of [{}, { validated: false }, { validated: true, workspaceId: 'other' }]) expect((await app.inject({ method: 'POST', url: `/attribution/ctwa/events/${id}/dispatch`, headers, payload })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: `/attribution/ctwa/events/${id}/dispatch`, headers, payload: { validated: true } })).statusCode).toBe(200); expect(service.dispatch).toHaveBeenCalledExactlyOnceWith('synthetic-authorized-workspace', id);
      service.dispatch.mockRejectedValueOnce(new CtwaOperationError('not_found', 404)); expect((await app.inject({ method: 'POST', url: `/attribution/ctwa/events/${id}/dispatch`, headers, payload: { validated: true } })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});
