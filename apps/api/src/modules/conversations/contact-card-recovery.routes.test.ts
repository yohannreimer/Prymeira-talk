import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { conversationsRoutes } from './conversations.routes.js';

const conversationId = '00000000-0000-4000-8000-000000000001';
const messageId = '00000000-0000-4000-8000-000000000002';
const message = { id: messageId, workspaceId: 'workspace-a', conversationId,
  providerMessageId: 'provider-1', direction: 'inbound', type: 'system',
  body: 'Mensagem não reconhecida', mediaUrl: null, metadata: { historyImport: { source: 'evolution' } },
  status: 'delivered', sentByUserId: null, createdAt: new Date('2026-09-28T18:55:00Z') };
const conversation = { id: conversationId, workspaceId: 'workspace-a', channel: { provider: 'evolution', providerKey: 'my-instance' },
  contact: { phone: '556784432788' } };
const original = { key: { id: 'provider-1', remoteJid: '556784432788@s.whatsapp.net', fromMe: false },
  message: { contactMessage: { displayName: 'Nelson Tecol', vcard: 'BEGIN:VCARD\nTEL;waid=556784432788:+55 67 8443-2788\nEND:VCARD' } } };

describe('recovering a previously unrecognized contact', () => {
  async function setup(record: typeof original | null = original) {
    const findFirst = vi.fn().mockResolvedValue(message);
    const update = vi.fn().mockImplementation(async ({ data }) => ({ ...message, ...data }));
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findMessage = vi.fn().mockResolvedValue(record);
    const publish = vi.fn();
    const app = Fastify({ logger: false });
    app.decorate('prisma', { message: { findFirst, update }, conversation: { findFirst: vi.fn().mockResolvedValue(conversation), updateMany } } as never);
    app.decorate('realtime', { publish } as never);
    app.addHook('preHandler', async request => { request.talk = { workspaceId: 'workspace-a', role: 'agent' }; });
    await app.register(conversationsRoutes, { messageHistory: { findMessage } });
    return { app, findFirst, update, updateMany, findMessage, publish };
  }

  it('restores the card and keeps historical metadata', async () => {
    const context = await setup();
    try {
      const response = await context.app.inject({ method: 'POST', url: `/conversations/${conversationId}/messages/${messageId}/recognize-contact` });
      expect(response.statusCode).toBe(200);
      expect(response.json().contactCards).toEqual([{ fullName: 'Nelson Tecol', phoneNumber: '556784432788' }]);
      expect(context.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
        type: 'text', metadata: expect.objectContaining({ historyImport: { source: 'evolution' }, contactCards: expect.any(Array) })
      }) }));
      expect(context.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.updated', workspaceId: 'workspace-a' }));
    } finally { await context.app.close(); }
  });

  it('rejects a provider message from another chat', async () => {
    const context = await setup({ ...original, key: { ...original.key, remoteJid: '5511999999999@s.whatsapp.net' } });
    try {
      const response = await context.app.inject({ method: 'POST', url: `/conversations/${conversationId}/messages/${messageId}/recognize-contact` });
      expect(response.statusCode).toBe(404);
      expect(context.update).not.toHaveBeenCalled();
    } finally { await context.app.close(); }
  });
});
