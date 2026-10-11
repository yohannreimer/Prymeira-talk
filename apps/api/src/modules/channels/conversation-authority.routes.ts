import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { listAuthorityReviews, resolveConversationAuthority } from './conversation-authority.js';

/** Chats that two conversations claim (typically a phone contact and a LID contact of the same person). Owners and
 * managers pick which conversation operates; nothing is merged or deleted. */
const canReview = (role: string) => role === 'owner' || role === 'manager';
const REFUSALS: Record<string, string> = {
  chat_not_found: 'Conversa duplicada não encontrada.',
  chat_redirected: 'Esta conversa já foi reorganizada; atualize a lista.',
  no_competing_conversations: 'Não há mais conversas concorrentes; atualize a lista.',
  conversation_not_a_member: 'Escolha uma das conversas da lista.',
  address_mapping_conflict: 'Os identificadores desta conversa estão em conflito e precisam de revisão antes.',
  send_outcome_unknown: 'Há um envio sem confirmação nesta conversa. Resolva em "Envios em revisão" primeiro.',
  prospecting_send_unconfirmed: 'Há um envio de prospecção sem confirmação em uma das conversas. Aguarde ou resolva antes.'
};

export const conversationAuthorityRoutes: FastifyPluginAsync<{ db: PrismaClient; onResolved?: (workspaceId: string, conversationIds: string[]) => Promise<void> | void }> = async (app, options) => {
  app.get('/channels/conversation-authority', async (request, reply) => {
    if (!canReview(request.talk.role)) return reply.code(403).send({ error: 'Forbidden.' });
    return { items: await listAuthorityReviews(options.db, { workspaceId: request.talk.workspaceId, limit: 50 }) };
  });
  app.post('/channels/conversation-authority/:chatId/resolve', async (request, reply) => {
    if (!canReview(request.talk.role)) return reply.code(403).send({ error: 'Forbidden.' });
    const params = z.object({ chatId: z.string().uuid() }).safeParse(request.params);
    const body = z.object({ conversationId: z.string().uuid() }).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'Invalid request.' });
    const { workspaceId } = request.talk;
    const chat = await options.db.canonicalChat.findFirst({ where: { workspaceId, id: params.data.chatId }, select: { channelId: true } });
    if (!chat) return reply.code(404).send({ error: REFUSALS.chat_not_found });
    const result = await resolveConversationAuthority(options.db, { workspaceId, channelId: chat.channelId, chatId: params.data.chatId,
      conversationId: body.data.conversationId, resolvedBy: request.talk.clerkUserId ?? request.talk.role });
    if (!result.ok) return reply.code(result.reason === 'chat_not_found' ? 404 : 409).send({ error: REFUSALS[result.reason] ?? 'Não foi possível resolver esta conversa.', reason: result.reason });
    await Promise.resolve(options.onResolved?.(workspaceId, [result.operationConversationId, ...result.retiredConversationIds])).catch(() => undefined);
    return { ok: true, operationConversationId: result.operationConversationId, recovered: result.recovered };
  });
};
