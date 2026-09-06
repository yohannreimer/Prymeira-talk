import type { Prisma, PrismaClient } from '@prisma/client';
import { createAssistantRepository } from './assistant-repository.js';
import { createAssistantGeneration, loadAssistantContext } from './assistant-generation.js';
import { AssistantError } from './assistant-access.js';
import { blocksAutonomousAgent } from './assistant-policy.js';

export function createAssistantScheduler(prisma: PrismaClient, dependencies: {
  generate?: ReturnType<typeof createAssistantGeneration>;
  repository?: ReturnType<typeof createAssistantRepository>;
  loadContext?: typeof loadAssistantContext;
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
          const context = await loadContext(prisma, state.workspaceId, state.conversationId);
          if (!state.requestedById && context.messages.at(-1)?.direction !== 'inbound') {
            await repository.fail(state, token, 'O cliente já recebeu uma resposta. Aguarde uma nova mensagem.');
            return;
          }
          const result = await generate(context, state.instruction);
          const published = await repository.publish(state, token, { ...result, actorUserId: state.requestedById, instruction: state.instruction }, async tx => {
            const current = await loadContext(tx, state.workspaceId, state.conversationId);
            return current.conversation.aiControlStatus === 'agent_allowed' && current.contextKey === context.contextKey;
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
      else await repository.invalidate(input.workspaceId, input.conversationId);
    },
    async control(workspaceId: string, conversationId: string, human: boolean) {
      await repository.invalidate(workspaceId, conversationId, human ? 'paused' : 'stale');
      // Reset the last input marker on release so an unanswered input can resume.
      if (!human) {
        await prisma.assistantConversationState.updateMany({ where: { workspaceId, conversationId }, data: { lastMessageId: null } });
        await repository.schedule({ workspaceId, conversationId, trigger: 'inbound' });
      }
    },
    start() { if (!timer) { timer = setInterval(() => void tick(), 1000); timer.unref(); } },
    stop() { if (timer) clearInterval(timer); timer = undefined; }
  };
}
export type AssistantScheduler = ReturnType<typeof createAssistantScheduler>;
