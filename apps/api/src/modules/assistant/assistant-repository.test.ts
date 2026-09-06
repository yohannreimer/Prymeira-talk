import { describe, it, expect, vi } from 'vitest';
import type { AssistantConversationState, PrismaClient } from '@prisma/client';
import { createAssistantRepository } from './assistant-repository.js';

describe('assistant durable leases', () => {
  const state = { id: 's', workspaceId: 'w', conversationId: 'c', revision: 4 } as AssistantConversationState;
  it('only the successful compare-and-swap worker obtains a lease', async () => {
    let claimed = false;
    const updateMany = vi.fn(async () => { if (claimed) return { count: 0 }; claimed = true; return { count: 1 }; });
    const repository = createAssistantRepository({ assistantConversationState: { updateMany } } as unknown as PrismaClient);
    const leases = await Promise.all([repository.claim(state), repository.claim(state)]);
    expect(leases.filter(Boolean)).toHaveLength(1);
    expect(updateMany.mock.calls[0]).toBeDefined();
  });
  it('does not publish an old revision or expired lease', async () => {
    const create = vi.fn();
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const tx = { $queryRaw: vi.fn(), assistantConversationState: { updateMany }, assistantSuggestion: { create } };
    const repository = createAssistantRepository({ $transaction: (fn: (db: unknown) => unknown) => fn(tx) } as unknown as PrismaClient);
    expect(await repository.publish(state, 'old-token', { agentId: 'a', contextKey: 'context', agentHash: 'hash', body: 'reply' }, async () => true)).toBe(false);
    expect(updateMany.mock.calls[0][0].where).toMatchObject({ workspaceId: 'w', revision: 4, leaseToken: 'old-token' });
    expect(create).not.toHaveBeenCalled();
  });
  it('checks human control/context before publication', async () => {
    const updateMany = vi.fn();
    const tx = { $queryRaw: vi.fn(), assistantConversationState: { updateMany } };
    const repository = createAssistantRepository({ $transaction: (fn: (db: unknown) => unknown) => fn(tx) } as unknown as PrismaClient);
    expect(await repository.publish(state, 'token', { agentId: 'a', contextKey: 'context', agentHash: 'hash', body: 'reply' }, async () => false)).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
