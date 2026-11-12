import type { FastifyPluginAsync } from 'fastify';
import { extensionAccountSchema, extensionChatSchema, extensionQueueQuerySchema, extensionNavigationSchema } from '@prymeira-talk/shared';
import { AssistantError } from '../assistant/assistant-access.js';
import { listExtensionChannels, resolveExtensionConversation } from './browser-extension.service.js';

import { listExtensionQueue, resolveExtensionQueueTarget } from './browser-extension-queues.js';
import { createExtensionConnectionService } from './browser-extension-connection.js';
import { createChannelConnectionsService, ConnectionServiceError } from '../channels/channel-connections.js';
import { createChannelsService, ChannelsServiceError, type PrismaLike } from '../channels/channels.service.js';
import type { EvolutionRuntime } from '../evolution/evolution-runtime.js';
import type { WahaRuntime } from '../waha/waha.client.js';

export const browserExtensionRoutes: FastifyPluginAsync<{ evolution?: EvolutionRuntime; waha?: WahaRuntime; clearManualDisconnect?: (id: string) => void }> = async (app, options) => {
  app.setErrorHandler((error, _request, reply) => error instanceof AssistantError
    ? reply.code(error.statusCode).send({ code: error.code, error: error.message }) : reply.send(error));
  app.addHook('onSend', async (_request, reply, payload) => { reply.header('Cache-Control', 'private, no-store'); return payload; });
  app.get('/browser-extension/channels', async request => listExtensionChannels(app.prisma, request.talk));
  const connections = createExtensionConnectionService(app.prisma, {
    physical: createChannelConnectionsService(app.prisma, options),
    primary: createChannelsService(app.prisma as unknown as PrismaLike, options),
    wahaEnabled: workspaceId => !!(options.waha?.enabled && options.waha.client && (options.waha.allows?.(workspaceId) ?? true)),
    onChannel: channel => app.realtime?.publish({ type: 'channel.updated', workspaceId: channel.workspaceId, payload: channel }),
    clearManualDisconnect: options.clearManualDisconnect,
  });
  for (const operation of ['connection', 'reconnect'] as const) {
    app.post(`/browser-extension/${operation}`, { config: { rateLimit: { max: operation === 'reconnect' ? 12 : 30, timeWindow: '1 minute' } } }, async (request, reply) => {
      const account = extensionAccountSchema.safeParse(request.body);
      if (!account.success) return reply.code(400).send({ code: 'EXTENSION_INVALID_ACCOUNT', error: 'Identificação do WhatsApp inválida.' });
      try { return operation === 'connection' ? await connections.status(request.talk, account.data) : await connections.reconnect(request.talk, account.data); }
      catch (error) {
        if (error instanceof AssistantError) throw error;
        if (error instanceof ConnectionServiceError || error instanceof ChannelsServiceError)
          return reply.code(error.statusCode).send({ code: error.code, error: error.message });
        return reply.code(503).send({ code: 'EXTENSION_CONNECTION_UNAVAILABLE', error: 'Não foi possível falar com o serviço de conexão. Tente novamente em instantes.' });
      }
    });
  }
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
