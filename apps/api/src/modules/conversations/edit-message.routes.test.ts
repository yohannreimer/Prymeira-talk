import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { conversationsRoutes } from './conversations.routes.js';

const conversationId = '00000000-0000-4000-8000-000000000001';
const messageId = '00000000-0000-4000-8000-000000000002';
const message = {
  id: messageId, workspaceId: 'workspace-a', conversationId, providerMessageId: '3EB0SENT',
  direction: 'outbound', type: 'text', body: 'Olá, tudo bem?', mediaUrl: null, metadata: {}, status: 'delivered',
  sentByUserId: null, createdAt: new Date('2026-10-05T12:00:00.000Z'),
  conversation: { channel: { provider: 'evolution', providerKey: 'vendas-5' }, contact: { phone: '5511999999999', isGroup: false } }
};

describe('edit a sent message', () => {
  afterEach(() => { vi.useRealTimers(); });
  async function setup(record: typeof message = message, reject = false) {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-05T12:05:00.000Z'));
    const editMessage = reject ? vi.fn().mockRejectedValue(new Error('provider failed')) : vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockImplementation(async ({ data }) => ({ ...record, ...data }));
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const publish = vi.fn();
    const app = Fastify({ logger: false });
    app.decorate('prisma', { message: { findFirst: vi.fn().mockResolvedValue(record), update }, conversation: { updateMany, findUnique: vi.fn().mockResolvedValue(null) } } as never);
    app.decorate('realtime', { publish } as never);
    app.addHook('preHandler', async request => { request.talk = { workspaceId: 'workspace-a', role: 'agent' }; });
    await app.register(conversationsRoutes, { evolution: { mode: 'real', client: { editMessage } } as never });
    const send = (body: unknown) => app.inject({ method: 'POST', url: `/conversations/${conversationId}/messages/${messageId}/edit`, payload: body as never });
    return { app, editMessage, update, updateMany, publish, send };
  }

  it('edits on WhatsApp first, then shows the new text as edited', async () => {
    const context = await setup();
    try {
      const response = await context.send({ body: '  Olá, tudo certo?  ' });
      expect(response.statusCode).toBe(200);
      expect(context.editMessage).toHaveBeenCalledWith({ instanceName: 'vendas-5', id: '3EB0SENT', remoteJid: '5511999999999@s.whatsapp.net', text: 'Olá, tudo certo?' });
      expect(response.json()).toMatchObject({ body: 'Olá, tudo certo?', editedAt: expect.any(String) });
      expect(context.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.updated' }));
    } finally { await context.app.close(); }
  });
  it('keeps the message when WhatsApp refuses the edit', async () => {
    const context = await setup(message, true);
    try {
      expect((await context.send({ body: 'novo' })).statusCode).toBe(502);
      expect(context.update).not.toHaveBeenCalled();
    } finally { await context.app.close(); }
  });
  it('refuses after WhatsApp\'s 15 minutes, for received, media and group messages, and an empty text', async () => {
    for (const [record, body, code] of [
      [{ ...message, createdAt: new Date('2026-10-05T11:49:00.000Z') }, 'novo', 409],
      [{ ...message, direction: 'inbound' }, 'novo', 409],
      [{ ...message, type: 'image' }, 'novo', 409],
      [{ ...message, conversation: { ...message.conversation, contact: { phone: '1203@g.us', isGroup: true } } }, 'novo', 409],
      [message, '   ', 400]
    ] as const) {
      const context = await setup(record as typeof message);
      try {
        expect((await context.send({ body })).statusCode).toBe(code);
        expect(context.editMessage).not.toHaveBeenCalled();
      } finally { await context.app.close(); }
    }
  });
});
