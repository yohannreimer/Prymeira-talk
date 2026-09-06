import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { assistantChannelSettingsSchema, assistantInstructionSchema, assistantSendSchema, assistantDraftStatusSchema, type AssistantConversationDto } from '@prymeira-talk/shared';
import { AssistantError, requireAssistantConversation, requireAssistantManager, resolveAssistantActor } from './assistant-access.js';
import { loadAssistantContext } from './assistant-generation.js';
import { readAssistantSettings } from './assistant-policy.js';
import { createAssistantSendService } from './assistant-send.service.js';
import type { AssistantScheduler } from './assistant-scheduler.js';
import { createConversationsService, type PrismaLike } from '../conversations/conversations.service.js';
import type { EvolutionRuntime } from '../evolution/evolution-runtime.js';
import { resolveMetaRuntime } from '../meta/meta-runtime.js';

const params = z.object({ conversationId: z.string().uuid() });
const channelParams = z.object({ channelId: z.string().uuid() });
const object = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, Prisma.InputJsonValue> : {};

export const assistantInboxRoutes: FastifyPluginAsync<{ scheduler?: AssistantScheduler; evolution: EvolutionRuntime }> = async (app, options) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AssistantError) return reply.code(error.statusCode).send({ code: error.code, error: error.message });
    if (error instanceof z.ZodError) return reply.code(400).send({ code: 'ASSISTANT_INVALID_REQUEST', error: 'Revise os campos informados.' });
    return reply.send(error);
  });
  app.get('/assistant/channels/:channelId/settings', async request => {
    const { channelId } = channelParams.parse(request.params);
    const actor = await resolveAssistantActor(app.prisma, request.talk);
    const channel = await app.prisma.channel.findFirst({ where: { workspaceId: actor.workspaceId, id: channelId } });
    if (!channel) throw new AssistantError('CHANNEL_NOT_FOUND', 'Canal não encontrado.', 404);
    return readAssistantSettings(channel.encryptedConfig);
  });
  app.put('/assistant/channels/:channelId/settings', async request => {
    const { channelId } = channelParams.parse(request.params);
    const settings = assistantChannelSettingsSchema.parse(request.body);
    const actor = await resolveAssistantActor(app.prisma, request.talk); requireAssistantManager(actor);
    await app.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM channels WHERE workspace_id = ${actor.workspaceId} AND id = ${channelId}::uuid FOR UPDATE`;
      const channel = await tx.channel.findFirst({ where: { workspaceId: actor.workspaceId, id: channelId } });
      if (!channel) throw new AssistantError('CHANNEL_NOT_FOUND', 'Canal não encontrado.', 404);
      if (settings.agentId && !await tx.aiAgent.findFirst({ where: { workspaceId: actor.workspaceId, id: settings.agentId } })) throw new AssistantError('ASSISTANT_AGENT_REQUIRED', 'Selecione um agente deste espaço de trabalho.', 422);
      await tx.channel.update({ where: { workspaceId_id: { workspaceId: actor.workspaceId, id: channelId } }, data: { encryptedConfig: { ...object(channel.encryptedConfig), assistant: settings } } });
      await tx.assistantConversationState.updateMany({ where: { workspaceId: actor.workspaceId, conversation: { channelId } }, data: { revision: { increment: 1 }, status: 'stale', scheduledAt: null } });
    });
    return settings;
  });
  app.get('/assistant/conversations/:conversationId', async request => {
    const { conversationId } = params.parse(request.params);
    const actor = await resolveAssistantActor(app.prisma, request.talk);
    const conversation = await requireAssistantConversation(app.prisma, actor, conversationId);
    const settings = readAssistantSettings(conversation.channel.encryptedConfig);
    const [state, revisions] = await Promise.all([
      app.prisma.assistantConversationState.findUnique({ where: { workspaceId_conversationId: { workspaceId: actor.workspaceId, conversationId } } }),
      app.prisma.assistantSuggestion.findMany({ where: { workspaceId: actor.workspaceId, conversationId }, orderBy: { revision: 'desc' }, take: 20, include: { actor: { select: { displayName: true } }, send: { include: { actor: { select: { displayName: true } }, message: { select: { status: true } } } } } })
    ]);
    let context: Awaited<ReturnType<typeof loadAssistantContext>> | null = null;
    if (settings.mode !== 'disabled') context = await loadAssistantContext(app.prisma, actor.workspaceId, conversationId);
    const history = revisions.map(s => ({ id: s.id, conversationId, agentId: s.agentId, revision: s.revision, contextKey: s.contextKey, body: s.body, instruction: s.instruction, createdAt: s.createdAt.toISOString(), warnings: Array.isArray(s.warnings) ? s.warnings.filter((w): w is string => typeof w === 'string') : [], actorName: s.send?.actor.displayName ?? s.actor?.displayName ?? null, finalBody: s.send?.finalBody ?? null, messageId: s.send?.messageId ?? null, sendStatus: s.send?.status === 'uncertain' ? 'uncertain' : s.send?.message?.status ?? s.send?.status ?? null }));
    const humanControlled = conversation.aiControlStatus === 'human_controlled';
    let status = assistantDraftStatusSchema.catch('stale').parse(state?.status ?? 'stale');
    if (humanControlled) status = 'paused';
    if (status === 'ready' && history[0]?.contextKey !== context?.contextKey) status = 'stale';
    return { settings, status, humanControlled, suggestion: history[0] ?? null, history, agentName: context?.agent.name ?? null, error: state?.lastError ?? null, currentContextKey: context?.contextKey ?? null } satisfies AssistantConversationDto;
  });
  app.post('/assistant/conversations/:conversationId/suggestions', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { conversationId } = params.parse(request.params);
    const body = assistantInstructionSchema.parse(request.body ?? {});
    const actor = await resolveAssistantActor(app.prisma, request.talk);
    await requireAssistantConversation(app.prisma, actor, conversationId);
    if (!options.scheduler || !await options.scheduler.repository.schedule({ workspaceId: actor.workspaceId, conversationId, trigger: 'manual', actorUserId: actor.userId, instruction: body.instruction })) throw new AssistantError('ASSISTANT_UNAVAILABLE', 'Libere o controle humano e configure a IA de apoio para gerar uma sugestão.');
    return reply.code(202).send({ status: 'pending' });
  });
  app.post('/assistant/conversations/:conversationId/send', async request => {
    const { conversationId } = params.parse(request.params);
    const input = assistantSendSchema.parse(request.body);
    const actor = await resolveAssistantActor(app.prisma, request.talk);
    const conversation = await requireAssistantConversation(app.prisma, actor, conversationId);
    const meta = await resolveMetaRuntime(app.prisma, { workspaceId: actor.workspaceId });
    if (conversation.channel.provider === 'evolution' && (options.evolution.mode !== 'real' || !options.evolution.client)) throw new AssistantError('ASSISTANT_TRANSPORT_REQUIRED', 'Conecte o canal real antes de enviar.', 422);
    if (conversation.channel.provider === 'meta_cloud' && !meta.client && !meta.evolutionClient) throw new AssistantError('ASSISTANT_TRANSPORT_REQUIRED', 'Configure o canal Meta antes de enviar.', 422);
    const service = createConversationsService(app.prisma as unknown as PrismaLike, { evolution: options.evolution, meta: { client: meta.client, phoneNumberId: meta.phoneNumberId }, metaEvolution: { client: meta.evolutionClient } });
    const result = await createAssistantSendService(app.prisma, payload => service.createPendingOutboundMessage(payload))(actor, conversationId, input);
    if ('message' in result && result.message && result.conversation) {
      app.realtime.publish({ type: 'message.created', workspaceId: actor.workspaceId, payload: result.message });
      app.realtime.publish({ type: 'conversation.updated', workspaceId: actor.workspaceId, payload: result.conversation });
    }
    return result;
  });
};
