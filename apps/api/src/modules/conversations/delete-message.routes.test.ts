import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { conversationsRoutes } from './conversations.routes.js';

const conversationId = '00000000-0000-4000-8000-000000000001';
const messageId = '00000000-0000-4000-8000-000000000002';
const timestamp = new Date('2026-09-29T12:00:00.000Z');
const message = {
  id: messageId, workspaceId: 'workspace-a', conversationId, providerMessageId: 'provider-1',
  direction: 'outbound', type: 'text', body: 'Olá', mediaUrl: null, metadata: {}, status: 'sent',
  sentByUserId: null, createdAt: timestamp,
  conversation: { channel: { provider: 'evolution', providerKey: 'vendas-5' }, contact: { phone: '5511999999999', isGroup: false } }
};

describe('delete message for everyone', () => {
  async function setup(record: typeof message = message, reject = false) {
    const deleteMessageForEveryone = reject ? vi.fn().mockRejectedValue(new Error('provider failed')) : vi.fn().mockResolvedValue(undefined);
    const findFirst = vi.fn().mockResolvedValue(record);
    const update = vi.fn().mockImplementation(async ({ data }) => ({ ...record, ...data }));
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const publish = vi.fn();
    const app = Fastify({ logger: false });
    app.decorate('prisma', { message: { findFirst, update }, conversation: {
      updateMany, findUnique: vi.fn().mockResolvedValue(null)
    } } as never);
    app.decorate('realtime', { publish } as never);
    app.addHook('preHandler', async request => { request.talk = { workspaceId: 'workspace-a', role: 'agent' }; });
    await app.register(conversationsRoutes, { evolution: { mode: 'real', client: { deleteMessageForEveryone } } as never });
    return { app, deleteMessageForEveryone, update, updateMany, publish };
  }

  it('revokes a sent message and then replaces its Talk bubble', async () => {
    const context = await setup();
    try {
      const response = await context.app.inject({ method: 'POST', url: `/conversations/${conversationId}/messages/${messageId}/delete-for-everyone` });
      expect(response.statusCode).toBe(200);
      expect(context.deleteMessageForEveryone).toHaveBeenCalledWith({ instanceName: 'vendas-5',
        id: 'provider-1', remoteJid: '5511999999999@s.whatsapp.net', fromMe: true });
      expect(context.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
        body: 'Você apagou esta mensagem', type: 'system', mediaUrl: null
      }) }));
      expect(response.json().deletedAt).toBeTruthy();
      expect(context.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.updated' }));
    } finally { await context.app.close(); }
  });

  it('revokes a message the canonical writer stored (WhatsApp id in metadata, no providerMessageId)', async () => {
    const context = await setup({ ...message, providerMessageId: null as never, metadata: { whatsapp: { id: '3EB0CANON', fromMe: true } } as never });
    try {
      const response = await context.app.inject({ method: 'POST', url: `/conversations/${conversationId}/messages/${messageId}/delete-for-everyone` });
      expect(response.statusCode).toBe(200);
      expect(context.deleteMessageForEveryone).toHaveBeenCalledWith(expect.objectContaining({ id: '3EB0CANON', fromMe: true }));
      expect(response.json().whatsappId).toBe('3EB0CANON');
    } finally { await context.app.close(); }
  });

  it('keeps the Talk message when the provider rejects deletion', async () => {
    const context = await setup(message, true);
    try {
      const response = await context.app.inject({ method: 'POST', url: `/conversations/${conversationId}/messages/${messageId}/delete-for-everyone` });
      expect(response.statusCode).toBe(502);
      expect(context.update).not.toHaveBeenCalled();
      expect(context.publish).not.toHaveBeenCalled();
    } finally { await context.app.close(); }
  });

  it('refuses to revoke an inbound message', async () => {
    const context = await setup({ ...message, direction: 'inbound' });
    try {
      const response = await context.app.inject({ method: 'POST', url: `/conversations/${conversationId}/messages/${messageId}/delete-for-everyone` });
      expect(response.statusCode).toBe(409);
      expect(context.deleteMessageForEveryone).not.toHaveBeenCalled();
    } finally { await context.app.close(); }
  });

  it('does not offer group deletion without a verified provider result', async () => {
    const context = await setup({ ...message, conversation: { ...message.conversation,
      contact: { phone: '12345@g.us', isGroup: true } } });
    try {
      const response = await context.app.inject({ method: 'POST', url: `/conversations/${conversationId}/messages/${messageId}/delete-for-everyone` });
      expect(response.statusCode).toBe(409);
      expect(context.deleteMessageForEveryone).not.toHaveBeenCalled();
    } finally { await context.app.close(); }
  });
});
