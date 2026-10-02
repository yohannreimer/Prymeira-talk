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

  describe('with the shared transcription job', () => {
    async function build(run: ReturnType<typeof vi.fn>) {
      const findFirst = vi.fn().mockResolvedValue(record);
      const update = vi.fn();
      const publish = vi.fn();
      const app = Fastify({ logger: false });
      app.decorate('prisma', { message: { findFirst, update } } as never);
      app.decorate('realtime', { publish } as never);
      app.addHook('preHandler', async request => { request.talk = { workspaceId: 'workspace-a', role: 'agent' }; });
      await app.register(conversationsRoutes, { transcriptions: { run } as never });
      return { app, update, publish };
    }
    const url = `/conversations/${conversationId}/messages/${messageId}/transcription`;

    it('lets the job own persistence: the route does not write the body and the manual click can retry a failure', async () => {
      mocks.media.mockResolvedValue({ bytes: Buffer.from('audio'), mimeType: 'audio/mpeg' });
      mocks.settings.mockResolvedValue({ active: true, baseUrl: 'https://provider.example/v1', apiKey: 'test', chatModel: 'test' });
      mocks.transcribe.mockResolvedValue({ text: 'Pedido de orçamento' });
      const run = vi.fn(async (job: { work: () => Promise<{ text: string }> }) => ({ status: 'completed', text: (await job.work()).text, message: { ...record, body: 'Pedido de orçamento' } }));
      const { app, update, publish } = await build(run);
      try {
        const response = await app.inject({ method: 'POST', url });
        expect(response.json()).toEqual({ text: 'Pedido de orçamento' });
        expect(run).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace-a', conversationId, messageId, retryFailed: true }));
        expect(update).not.toHaveBeenCalled();
        expect(publish).toHaveBeenCalledTimes(1);
      } finally { await app.close(); }
    });

    it('answers a transcription somebody else already finished without publishing again or calling the provider', async () => {
      const run = vi.fn(async () => ({ status: 'completed', text: 'já pronto', message: null }));
      const { app, publish } = await build(run);
      try {
        const response = await app.inject({ method: 'POST', url });
        expect(response.json()).toEqual({ text: 'já pronto' });
        expect(publish).not.toHaveBeenCalled();
        expect(mocks.transcribe).not.toHaveBeenCalled();
      } finally { await app.close(); }
    });

    it.each([[{ status: 'in_progress' }], [{ status: 'failed', errorCode: 'MEDIA_UNAVAILABLE', message: null }]])('reports %j as a recoverable failure', async outcome => {
      const { app } = await build(vi.fn(async () => outcome));
      try {
        const response = await app.inject({ method: 'POST', url });
        expect(response.statusCode).toBe(422);
        expect(response.json()).toEqual({ error: 'Não foi possível transcrever este áudio. Tente novamente.' });
      } finally { await app.close(); }
    });
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
