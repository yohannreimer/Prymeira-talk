import type { FastifyPluginAsync } from 'fastify';
import { extensionChatSchema } from '@prymeira-talk/shared';
import { AssistantError } from '../assistant/assistant-access.js';
import { listExtensionChannels, resolveExtensionConversation } from './browser-extension.service.js';

export const browserExtensionRoutes: FastifyPluginAsync = async app => {
  app.setErrorHandler((error, _request, reply) => error instanceof AssistantError
    ? reply.code(error.statusCode).send({ code: error.code, error: error.message }) : reply.send(error));
  app.addHook('onSend', async (_request, reply, payload) => { reply.header('Cache-Control', 'private, no-store'); return payload; });
  app.get('/browser-extension/channels', async request => listExtensionChannels(app.prisma, request.talk));
  app.post('/browser-extension/resolve', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = extensionChatSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'EXTENSION_INVALID_CHAT', error: 'Identificação da conversa inválida.' });
    return resolveExtensionConversation(app.prisma, request.talk, parsed.data);
  });
};
