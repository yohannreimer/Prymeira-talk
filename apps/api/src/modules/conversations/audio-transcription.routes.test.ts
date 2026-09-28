import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { conversationsRoutes } from './conversations.routes.js';

const mocks = vi.hoisted(() => ({ media: vi.fn(), transcribe: vi.fn(), settings: vi.fn() }));
vi.mock('./inbox-media.js', () => ({ createInboxMediaService: () => ({ media: mocks.media }) }));
vi.mock('../agents/inbound-media.js', async importOriginal => ({
  ...await importOriginal<typeof import('../agents/inbound-media.js')>(),
  transcribeInboundAudio: mocks.transcribe
}));
vi.mock('../agents/ai-provider-settings.js', async importOriginal => ({
  ...await importOriginal<typeof import('../agents/ai-provider-settings.js')>(),
  resolveOpenAiCompatibleSettings: mocks.settings
}));

describe('requested audio transcription', () => {
  afterEach(() => vi.clearAllMocks());
  const conversationId = '00000000-0000-4000-8000-000000000001';
  const messageId = '00000000-0000-4000-8000-000000000002';
  const record = {
    id: messageId, conversationId, workspaceId: 'workspace-a', providerMessageId: null,
    direction: 'inbound', type: 'audio', body: 'Áudio recebido', mediaUrl: 'data:audio/mpeg;base64,YQ==',
    metadata: {}, status: 'delivered', sentByUserId: null, createdAt: new Date('2026-09-28T16:54:00Z')
  };

  it('transcribes a tenant-owned audio and publishes the saved text', async () => {
    const findFirst = vi.fn().mockResolvedValue(record);
    const update = vi.fn().mockResolvedValue({ ...record, body: 'Pedido de orçamento' });
    const publish = vi.fn();
    mocks.media.mockResolvedValue({ bytes: Buffer.from('audio'), mimeType: 'audio/mpeg' });
    mocks.settings.mockResolvedValue({ active: true, baseUrl: 'https://provider.example/v1', apiKey: 'test', chatModel: 'test' });
    mocks.transcribe.mockResolvedValue({ text: 'Pedido de orçamento' });
    const app = Fastify({ logger: false });
    app.decorate('prisma', { message: { findFirst, update } } as never);
    app.decorate('realtime', { publish } as never);
    app.addHook('preHandler', async request => { request.talk = { workspaceId: 'workspace-a', role: 'agent' }; });
    await app.register(conversationsRoutes);
    try {
      const response = await app.inject({ method: 'POST', url: `/conversations/${conversationId}/messages/${messageId}/transcription` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ text: 'Pedido de orçamento' });
      expect(findFirst).toHaveBeenCalledWith({ where: { id: messageId, conversationId, workspaceId: 'workspace-a', type: 'audio' } });
      expect(update).toHaveBeenCalledWith({ where: { id: messageId }, data: { body: 'Pedido de orçamento' } });
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.created', workspaceId: 'workspace-a' }));
    } finally { await app.close(); }
  });

  it('does not transcribe a message outside the workspace', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const app = Fastify({ logger: false });
    app.decorate('prisma', { message: { findFirst } } as never);
    app.addHook('preHandler', async request => { request.talk = { workspaceId: 'workspace-a', role: 'agent' }; });
    await app.register(conversationsRoutes);
    try {
      const response = await app.inject({ method: 'POST', url: `/conversations/${conversationId}/messages/${messageId}/transcription` });
      expect(response.statusCode).toBe(404);
      expect(mocks.media).not.toHaveBeenCalled();
      expect(mocks.transcribe).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
