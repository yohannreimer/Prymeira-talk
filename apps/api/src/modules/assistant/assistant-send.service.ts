import type { PrismaClient } from '@prisma/client';
import type { AssistantSendInput, ConversationDto, MessageDto } from '@prymeira-talk/shared';
import { AssistantError, lockAssistantConversation, requireAssistantConversation, type AssistantActor } from './assistant-access.js';
import { assistantHash, loadAssistantContext } from './assistant-generation.js';

export function createAssistantSendService(prisma: PrismaClient, transport: (input: { workspaceId: string; conversationId: string; body: string; sentByUserId: string; reservedMessageId: string }) => Promise<{ message: MessageDto; conversation: ConversationDto }>) {
  return async (actor: AssistantActor, conversationId: string, input: AssistantSendInput) => {
    const bodyHash = assistantHash(input.body);
    const reservation = await prisma.$transaction(async tx => {
      await lockAssistantConversation(tx, actor.workspaceId, conversationId);
      await requireAssistantConversation(tx, actor, conversationId);
      const previous = await tx.assistantSuggestionSend.findFirst({ where: { workspaceId: actor.workspaceId, OR: [{ requestKey: input.requestKey }, { suggestionId: input.suggestionId }] }, include: { suggestion: true } });
      if (previous) {
        if (previous.requestKey !== input.requestKey || previous.bodyHash !== bodyHash || previous.suggestionId !== input.suggestionId || previous.suggestion.conversationId !== conversationId || previous.actorUserId !== actor.userId) throw new AssistantError('ASSISTANT_SEND_CONFLICT', 'Esta sugestão já tem um envio registrado. Confira a conversa.');
        return { fresh: false as const, send: previous };
      }
      const suggestion = await tx.assistantSuggestion.findFirst({ where: { workspaceId: actor.workspaceId, conversationId, id: input.suggestionId } });
      if (!suggestion) throw new AssistantError('ASSISTANT_NOT_FOUND', 'Sugestão não encontrada.', 404);
      if (!input.edited) {
        const state = await tx.assistantConversationState.findUnique({ where: { workspaceId_conversationId: { workspaceId: actor.workspaceId, conversationId } } });
        if (state?.status !== 'ready' || state.revision !== suggestion.revision) throw new AssistantError('ASSISTANT_STALE', 'A sugestão está sendo atualizada. Aguarde a nova revisão.');
      }
      const context = await loadAssistantContext(tx, actor.workspaceId, conversationId);
      if (context.conversation.aiControlStatus === 'human_controlled' && !input.edited) throw new AssistantError('ASSISTANT_PAUSED', 'O humano está no controle. Use o campo de mensagem para enviar manualmente.');
      if (context.contextKey !== input.reviewedContextKey || (!input.edited && suggestion.contextKey !== context.contextKey)) throw new AssistantError('ASSISTANT_STALE', 'A conversa mudou. Revise o texto antes de enviar.');
      const message = await tx.message.create({ data: { workspaceId: actor.workspaceId, conversationId, direction: 'outbound', type: 'text', body: input.body, status: 'pending', sentByUserId: actor.userId, metadata: { source: 'assistant_review', suggestionId: suggestion.id, requestKey: input.requestKey } } });
      const send = await tx.assistantSuggestionSend.create({ data: { workspaceId: actor.workspaceId, requestKey: input.requestKey, suggestionId: suggestion.id, bodyHash, finalBody: input.body, actorUserId: actor.userId, messageId: message.id } });
      await tx.assistantConversationState.updateMany({ where: { workspaceId: actor.workspaceId, conversationId }, data: { status: 'sent', revision: { increment: 1 }, scheduledAt: null } });
      // This commit is the explicit-send acceptance point. A later takeover cannot unsend it.
      return { fresh: true as const, send };
    });
    if (!reservation.fresh) return { sendId: reservation.send.id, status: reservation.send.status, messageId: reservation.send.messageId };
    try {
      const result = await transport({ workspaceId: actor.workspaceId, conversationId, body: input.body, sentByUserId: actor.userId, reservedMessageId: reservation.send.messageId! });
      await prisma.assistantSuggestionSend.update({ where: { id: reservation.send.id }, data: { status: result.message.status } });
      return { sendId: reservation.send.id, status: result.message.status, messageId: result.message.id, ...result };
    } catch {
      // Never repeat an ambiguous provider send. The reserved message survives a lost response.
      await prisma.assistantSuggestionSend.update({ where: { id: reservation.send.id }, data: { status: 'uncertain' } });
      return { sendId: reservation.send.id, status: 'uncertain', messageId: reservation.send.messageId };
    }
  };
}
