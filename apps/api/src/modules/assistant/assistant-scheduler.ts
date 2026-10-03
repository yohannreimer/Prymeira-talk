import { findProspectingReservation } from "../prospecting/prospecting-policy.js";
import type { Prisma, PrismaClient } from '@prisma/client';
import { createAssistantRepository } from './assistant-repository.js';
import { createAssistantGeneration, loadAssistantContext } from './assistant-generation.js';
import { AssistantError } from './assistant-access.js';
import { blocksAutonomousAgent } from './assistant-policy.js';

export function createAssistantScheduler(prisma: PrismaClient, dependencies: {
  generate?: ReturnType<typeof createAssistantGeneration>;
  repository?: ReturnType<typeof createAssistantRepository>;
  loadContext?: typeof loadAssistantContext;
  prepareContext?: (workspaceId: string, conversationId: string) => Promise<unknown>;
  onError?: (error: unknown) => void;
} = {}) {
  const repository = dependencies.repository ?? createAssistantRepository(prisma);
  const generate = dependencies.generate ?? createAssistantGeneration(prisma);
  const loadContext = dependencies.loadContext ?? loadAssistantContext;
  let timer: ReturnType<typeof setInterval> | undefined;
  let processing = false;
  async function tick() {
    if (processing) return;
    processing = true;
    try {
      const due = await repository.due();
      await Promise.all(due.map(async state => {
        const token = await repository.claim(state);
        if (!token) return;
        try {
          const prospecting = await findProspectingReservation(prisma, state.workspaceId, state.conversationId);
          if (prospecting && prospecting.status !== "stopped") { await repository.fail(state, token, "Conversa reservada para prospecção."); return; }
          await dependencies.prepareContext?.(state.workspaceId, state.conversationId);
          const context = await loadContext(prisma, state.workspaceId, state.conversationId);
          // Automatic suggestions answer the customer; after our own message only a requested follow-up is generated.
          if (!state.requestedById && context.messages.at(-1)?.direction !== 'inbound') {
            await repository.fail(state, token, 'O cliente já recebeu uma resposta. Aguarde uma nova mensagem.');
            return;
          }
          const result = await generate(context, state.instruction);
          const published = await repository.publish(state, token, { ...result, actorUserId: state.requestedById, instruction: state.instruction }, async tx => {
            const current = await loadContext(tx, state.workspaceId, state.conversationId);
            const prospecting = await findProspectingReservation(tx, state.workspaceId, state.conversationId);
            if (prospecting && prospecting.status !== "stopped") return false;
            return (current.conversation.aiControlStatus === 'agent_allowed' || current.humanSupport) && current.contextKey === context.contextKey;
          });
          if (!published) await repository.fail(state, token, 'A conversa mudou. Solicite uma nova sugestão.');
        } catch (error) {
          // Provider responses may contain credentials or customer data: do not persist raw errors.
          await repository.fail(state, token, error instanceof AssistantError ? error.message : 'Não foi possível gerar a sugestão. Tente novamente.');
        } finally { await repository.releaseLease(state, token); }
      }));
    } catch (error) { dependencies.onError?.(error); }
    finally { processing = false; }
  }
  /** Training pair: when a ready suggestion was on screen and the seller replied (typed in Talk, accepted, edited or
   * from the phone), keep both texts. Messages sent by the AI agent, automations or campaigns are not seller replies.
   * Best effort: a failure here never affects message processing. */
  async function recordReplySample(input: { workspaceId: string; conversationId: string; messageId: string }) {
    try {
      if (!prisma.assistantConversationState?.findUnique || !prisma.assistantReplySample?.createMany) return;
      const state = await prisma.assistantConversationState.findUnique({ where: { workspaceId_conversationId: { workspaceId: input.workspaceId, conversationId: input.conversationId } } });
      if (state?.status !== 'ready') return;
      const [message, suggestion] = await Promise.all([
        prisma.message.findFirst({ where: { workspaceId: input.workspaceId, id: input.messageId }, select: { body: true, type: true, sentByUserId: true, metadata: true } }),
        prisma.assistantSuggestion.findFirst({ where: { workspaceId: input.workspaceId, conversationId: input.conversationId, revision: state.revision }, select: { id: true, body: true } })
      ]);
      const reply = message?.type === 'text' ? message.body?.trim() : null;
      if (!message || !suggestion || !reply) return;
      const metadata = message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata) ? message.metadata as Record<string, unknown> : {};
      const source = metadata.source === 'assistant_review'
        ? metadata.suggestionId === suggestion.id ? (reply === suggestion.body.trim() ? 'suggestion_accepted' : 'suggestion_edited') : null
        : metadata.source !== undefined ? null : message.sentByUserId ? 'talk_typed' : 'phone';
      if (!source) return;
      await prisma.assistantReplySample.createMany({ data: [{ workspaceId: input.workspaceId, conversationId: input.conversationId, suggestionId: suggestion.id,
        messageId: input.messageId, source, suggestedBody: suggestion.body, replyBody: reply }], skipDuplicates: true });
    } catch (error) { dependencies.onError?.(error); }
  }
  return {
    repository, tick,
    async persistInbound(tx: Prisma.TransactionClient, input: { workspaceId: string; conversationId: string; messageId: string; direction: string }) {
      if (input.direction === 'inbound') await repository.schedule({ ...input, trigger: 'inbound' }, tx);
    },
    async isAssisted(workspaceId: string, conversationId: string) {
      const conversation = await prisma.conversation.findFirst({ where: { workspaceId, id: conversationId }, select: { channel: { select: { encryptedConfig: true } } } });
      return blocksAutonomousAgent(conversation?.channel.encryptedConfig);
    },
    async message(input: { workspaceId: string; conversationId: string; messageId: string; direction: string }) {
      if (input.direction === 'inbound') await repository.schedule({ ...input, trigger: 'inbound' });
      // After our own message the panel waits for the customer; a follow-up is only suggested on request.
      else {
        await recordReplySample(input);
        await repository.invalidate(input.workspaceId, input.conversationId);
      }
    },
    async control(workspaceId: string, conversationId: string, _human: boolean) {
      await repository.invalidate(workspaceId, conversationId);
      // Either control change may leave a customer message unanswered.
      await prisma.assistantConversationState.updateMany({ where: { workspaceId, conversationId }, data: { lastMessageId: null } });
      await repository.schedule({ workspaceId, conversationId, trigger: 'inbound' });
    },
    async handoffCompleted(workspaceId: string, conversationId: string) {
      await repository.invalidate(workspaceId, conversationId);
      await prisma.assistantConversationState.updateMany({ where: { workspaceId, conversationId }, data: { lastMessageId: null } });
      await repository.schedule({ workspaceId, conversationId, trigger: 'inbound' });
    },
    start() { if (!timer) { timer = setInterval(() => void tick(), 1000); timer.unref(); } },
    stop() { if (timer) clearInterval(timer); timer = undefined; }
  };
}
export type AssistantScheduler = ReturnType<typeof createAssistantScheduler>;
