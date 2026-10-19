import { describe, expect, it, vi } from 'vitest';
import { createAssistantScheduler } from './assistant-scheduler.js';

function setup(message: { body: string; type?: string; sentByUserId?: string | null; metadata?: unknown }, stateStatus = 'ready') {
  const createMany = vi.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    assistantConversationState: { findUnique: vi.fn().mockResolvedValue({ status: stateStatus, revision: 3 }) },
    message: { findFirst: vi.fn().mockResolvedValue({ type: 'text', sentByUserId: null, metadata: {}, ...message }) },
    assistantSuggestion: { findFirst: vi.fn().mockResolvedValue({ id: 's3', body: 'Temos sim, quer o orçamento?' }) },
    assistantReplySample: { createMany }
  };
  const invalidate = vi.fn().mockResolvedValue(undefined);
  const scheduler = createAssistantScheduler(prisma as never, { repository: { invalidate, schedule: vi.fn() } as never });
  const send = () => scheduler.message({ workspaceId: 'w', conversationId: 'c', messageId: 'm1', direction: 'outbound' });
  return { send, createMany, invalidate };
}

describe('suggestion × actual reply samples', () => {
  it.each([
    [{ body: 'Temos sim, quer o orçamento?', metadata: { source: 'assistant_review', suggestionId: 's3' }, sentByUserId: 'u' }, 'suggestion_accepted'],
    [{ body: 'Temos! Te mando o orçamento agora.', metadata: { source: 'assistant_review', suggestionId: 's3' }, sentByUserId: 'u' }, 'suggestion_edited'],
    [{ body: 'Tem sim, qual medida?', sentByUserId: 'u' }, 'talk_typed'],
    [{ body: 'Tem sim, qual medida?', sentByUserId: null }, 'phone']
  ])('records %o as %s, before invalidating', async (message, source) => {
    const s = setup(message);
    await s.send();
    expect(s.createMany).toHaveBeenCalledWith({ data: [{ workspaceId: 'w', conversationId: 'c', suggestionId: 's3', messageId: 'm1', source,
      suggestedBody: 'Temos sim, quer o orçamento?', replyBody: message.body }], skipDuplicates: true });
    expect(s.invalidate).toHaveBeenCalledWith('w', 'c');
  });
  it('ignores AI/automation messages, media, and replies with no ready suggestion on screen', async () => {
    for (const s of [setup({ body: 'Oi', metadata: { source: 'ai_agent' } }), setup({ body: 'Áudio enviado', type: 'audio', sentByUserId: 'u' }),
      setup({ body: 'Oi', sentByUserId: 'u' }, 'stale')]) {
      await s.send();
      expect(s.createMany).not.toHaveBeenCalled();
      expect(s.invalidate).toHaveBeenCalled();
    }
  });
});
