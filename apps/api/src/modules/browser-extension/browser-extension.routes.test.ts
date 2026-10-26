import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { authContextPlugin } from '../../plugins/auth-context.js';
import { browserExtensionRoutes } from './browser-extension.routes.js';

async function setup() {
  const app = Fastify();
  const db = { userProfile: { findFirst: vi.fn(async () => ({ id: 'profile-A' })) }, channel: { findMany: vi.fn(async () => []) } };
  app.decorate('prisma', db as never);
  await app.register(authContextPlugin, { accountApiUrl: 'http://account.test', productKey: 'talk', requireProductAccess: async () => ({
    allowed: true, product_key: 'talk', status: 'active', reason: 'allowed', workspace_id: 'workspace-A', product_role: 'owner' }) });
  await app.register(browserExtensionRoutes);
  const token = `test.${Buffer.from(JSON.stringify({ sub: 'user-A' })).toString('base64url')}.test`;
  return { app, db, headers: { authorization: `Bearer ${token}` } };
}
describe('extension endpoints stay behind the existing Talk authentication', () => {
  it('denies unauthenticated access and never queries the database', async () => {
    const { app, db } = await setup();
    try {
      expect((await app.inject({ url: '/browser-extension/channels' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/browser-extension/resolve', payload: {} })).statusCode).toBe(401);
      for(const path of ['queue','navigate']) expect((await app.inject({method:'POST',url:`/browser-extension/${path}`,payload:{}})).statusCode).toBe(401);
      expect(db.userProfile.findFirst).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('uses the account workspace and disables HTTP caching', async () => {
    const { app, db, headers } = await setup();
    try {
      const response = await app.inject({ url: '/browser-extension/channels', headers });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ workspaceId: 'workspace-A', role: 'owner', channels: [] });
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(db.userProfile.findFirst).toHaveBeenCalledWith({ where: { workspaceId: 'workspace-A', clerkUserId: 'user-A' } });
    } finally { await app.close(); }
  });
  it('rejects workspace injection and malformed chat identity at the HTTP boundary', async () => {
    const { app, headers, db } = await setup();
    try {
      const response = await app.inject({ method: 'POST', url: '/browser-extension/resolve', headers, payload: {
        channelId: '00000000-0000-4000-8000-000000000001', selfAddress: 'self', peerAddress: 'peer', workspaceId: 'victim' } });
      expect(response.statusCode).toBe(400); expect(response.json().code).toBe('EXTENSION_INVALID_CHAT');
      expect(db.userProfile.findFirst).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('rejects caller URLs and workspace fields on queue and navigation requests',async()=>{
    const {app,headers,db}=await setup();try{
      for(const path of ['queue','navigate']){
        const response=await app.inject({method:'POST',url:`/browser-extension/${path}`,headers,payload:{account:{channelId:'00000000-0000-4000-8000-000000000001',selfAddress:'self'},kind:'human',workspaceId:'victim',url:'https://evil.test'}});
        expect(response.statusCode).toBe(400);
      }expect(db.userProfile.findFirst).not.toHaveBeenCalled();
    }finally{await app.close();}
  });
});
