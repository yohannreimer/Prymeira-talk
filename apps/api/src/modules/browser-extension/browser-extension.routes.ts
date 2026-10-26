import type { FastifyPluginAsync } from 'fastify';
import { extensionChatSchema, extensionQueueQuerySchema, extensionNavigationSchema } from '@prymeira-talk/shared';
import { AssistantError } from '../assistant/assistant-access.js';
import { listExtensionChannels, resolveExtensionConversation } from './browser-extension.service.js';

import { listExtensionQueue, resolveExtensionQueueTarget } from './browser-extension-queues.js';

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
  app.post('/browser-extension/queue', async (request, reply) => {
    const input = extensionQueueQuerySchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ code: 'EXTENSION_INVALID_QUEUE', error: 'Filtro da fila inválido.' });
    return listExtensionQueue(app.prisma, request.talk, input.data);
  });
  app.post('/browser-extension/navigate', async (request, reply) => {
    const input = extensionNavigationSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ code: 'EXTENSION_INVALID_TARGET', error: 'Destino da conversa inválido.' });
    return resolveExtensionQueueTarget(app.prisma, request.talk, input.data);
  });
};
