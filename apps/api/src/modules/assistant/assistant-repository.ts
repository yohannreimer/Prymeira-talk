import { randomUUID } from 'node:crypto';
import type { AssistantConversationState, Prisma, PrismaClient } from '@prisma/client';
import { lockAssistantConversation } from './assistant-access.js';
import { canGenerateSuggestion, nextSuggestionAt, readAssistantSettings } from './assistant-policy.js';

export function createAssistantRepository(prisma: PrismaClient) {
  return {
    async schedule(input: { workspaceId: string; conversationId: string; trigger: 'manual' | 'inbound'; messageId?: string; actorUserId?: string; instruction?: string }, transaction?: Prisma.TransactionClient) {
      const perform = async (tx: Prisma.TransactionClient) => {
        await lockAssistantConversation(tx, input.workspaceId, input.conversationId);
        const conversation = await tx.conversation.findFirst({ where: { workspaceId: input.workspaceId, id: input.conversationId }, include: { channel: true } });
        if (!conversation) return false;
        const settings = readAssistantSettings(conversation.channel.encryptedConfig);
        const where = { workspaceId_conversationId: { workspaceId: input.workspaceId, conversationId: input.conversationId } };
        const state = await tx.assistantConversationState.findUnique({ where });
        if (!canGenerateSuggestion({ mode: settings.mode, control: conversation.aiControlStatus, trigger: input.trigger })) return false;
        const latest = await tx.message.findFirst({ where: { workspaceId: input.workspaceId, conversationId: input.conversationId, type: { notIn: ['internal_note', 'system'] } }, orderBy: [{ ingestedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }] });
        // A release never replays an already answered conversation. Duplicate hooks are harmless.
        if (!latest || (input.trigger === 'inbound' && (latest.direction !== 'inbound' || state?.lastMessageId === latest.id))) return false;
        const now = new Date();
        const firstPendingAt = state?.status === 'pending' ? state.firstPendingAt : now;
        const data = {
          lastMessageId: latest.id, status: 'pending', firstPendingAt,
          scheduledAt: new Date(input.trigger === 'manual' ? now.getTime() : nextSuggestionAt(firstPendingAt.getTime(), now.getTime())),
          leaseToken: state?.leaseToken ?? null, leaseUntil: state?.leaseUntil ?? null, lastError: null, attempts: 0,
          instruction: input.instruction ?? null, requestedById: input.actorUserId ?? null
        };
        await tx.assistantConversationState.upsert({ where,
          create: { workspaceId: input.workspaceId, conversationId: input.conversationId, ...data },
          update: { ...data, revision: { increment: 1 } }
        });
        return true;
      };
      return transaction ? perform(transaction) : prisma.$transaction(perform);
    },
    async invalidate(workspaceId: string, conversationId: string, status = 'stale') {
      await prisma.assistantConversationState.updateMany({ where: { workspaceId, conversationId }, data: { status, revision: { increment: 1 }, scheduledAt: null } });
    },
    async due(now = new Date()) {
      // Recover abandoned workers, but never retry more than twice.
      await prisma.assistantConversationState.updateMany({ where: { status: 'generating', leaseUntil: { lt: now }, attempts: { lt: 2 } }, data: { status: 'pending', leaseToken: null, leaseUntil: null, scheduledAt: now } });
      await prisma.assistantConversationState.updateMany({ where: { status: 'generating', leaseUntil: { lt: now }, attempts: { gte: 2 } }, data: { status: 'failed', lastError: 'Não foi possível gerar a sugestão. Tente novamente.', leaseToken: null, leaseUntil: null } });
      await prisma.assistantConversationState.updateMany({ where: { status: { not: 'generating' }, leaseUntil: { lt: now } }, data: { leaseToken: null, leaseUntil: null } });
      return prisma.assistantConversationState.findMany({ where: { status: 'pending', leaseToken: null, scheduledAt: { lte: now } }, orderBy: { scheduledAt: 'asc' }, take: 2 });
    },
    async releaseLease(state: AssistantConversationState, leaseToken: string) {
      await prisma.assistantConversationState.updateMany({ where: { id: state.id, workspaceId: state.workspaceId, leaseToken }, data: { leaseToken: null, leaseUntil: null } });
    },
    async claim(state: AssistantConversationState, now = new Date()) {
      const leaseToken = randomUUID();
      const result = await prisma.assistantConversationState.updateMany({ where: { id: state.id, workspaceId: state.workspaceId, revision: state.revision, status: 'pending', leaseToken: null }, data: { status: 'generating', leaseToken, leaseUntil: new Date(now.getTime() + 600_000), attempts: { increment: 1 } } });
      return result.count === 1 ? leaseToken : null;
    },
    async publish(state: AssistantConversationState, leaseToken: string, data: Omit<Prisma.AssistantSuggestionUncheckedCreateInput, 'workspaceId' | 'conversationId' | 'revision'>, stillCurrent: (tx: Prisma.TransactionClient) => Promise<boolean>) {
      return prisma.$transaction(async tx => {
        await lockAssistantConversation(tx, state.workspaceId, state.conversationId);
        if (!await stillCurrent(tx)) return false;
        const claimed = await tx.assistantConversationState.updateMany({ where: { id: state.id, workspaceId: state.workspaceId, revision: state.revision, status: 'generating', leaseToken }, data: { status: 'ready', leaseToken: null, leaseUntil: null, scheduledAt: null, lastError: null } });
        if (claimed.count !== 1) return false;
        await tx.assistantSuggestion.create({ data: { ...data, workspaceId: state.workspaceId, conversationId: state.conversationId, revision: state.revision } });
        return true;
      });
    },
    async fail(state: AssistantConversationState, leaseToken: string, message: string) {
      await prisma.assistantConversationState.updateMany({ where: { id: state.id, workspaceId: state.workspaceId, revision: state.revision, leaseToken }, data: { status: 'failed', lastError: message, leaseToken: null, leaseUntil: null, scheduledAt: null } });
    }
  };
}
