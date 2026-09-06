import { describe, it, expect, vi } from 'vitest';
import { resolveAssistantActor, requireAssistantConversation, requireAssistantManager, type AssistantDb } from './assistant-access.js';

describe('assistant access', () => {
  const actor = { workspaceId: 'w', userId: 'u', role: 'agent' as const };
  it('requires an authenticated profile, never a client-supplied ID', async () => {
    await expect(resolveAssistantActor({} as AssistantDb, { workspaceId: 'w', role: 'agent' })).rejects.toMatchObject({ statusCode: 422 });
    const findFirst = vi.fn().mockResolvedValue(null);
    await expect(resolveAssistantActor({ userProfile: { findFirst } } as unknown as AssistantDb, { workspaceId: 'w', clerkUserId: 'clerk', role: 'agent' })).rejects.toMatchObject({ statusCode: 422 });
    expect(findFirst).toHaveBeenCalledWith({ where: { workspaceId: 'w', clerkUserId: 'clerk' } });
  });
  it('resolves only the authenticated workspace profile', async () => {
    const db = { userProfile: { findFirst: vi.fn().mockResolvedValue({ id: 'u' }) } } as unknown as AssistantDb;
    expect(await resolveAssistantActor(db, { workspaceId: 'w', clerkUserId: 'clerk', role: 'agent' })).toEqual(actor);
  });
  it('checks the current assignment on every request', async () => {
    const findFirst = vi.fn().mockResolvedValueOnce({ assignedUserId: 'u' }).mockResolvedValueOnce({ assignedUserId: 'other' }).mockResolvedValueOnce(null);
    const db = { conversation: { findFirst } } as unknown as AssistantDb;
    await expect(requireAssistantConversation(db, actor, 'c')).resolves.toBeTruthy();
    await expect(requireAssistantConversation(db, actor, 'c')).rejects.toMatchObject({ statusCode: 403 });
    await expect(requireAssistantConversation(db, actor, 'c')).rejects.toMatchObject({ statusCode: 404 });
    expect(findFirst).toHaveBeenCalledWith({ where: { workspaceId: 'w', id: 'c' }, include: { channel: true } });
  });
  it.each(['owner', 'manager'] as const)('allows %s to review workspace conversations', async role => {
    const db = { conversation: { findFirst: vi.fn().mockResolvedValue({ assignedUserId: 'other' }) } } as unknown as AssistantDb;
    await expect(requireAssistantConversation(db, { ...actor, role }, 'c')).resolves.toBeTruthy();
    expect(() => requireAssistantManager({ ...actor, role })).not.toThrow();
  });
  it('prevents sellers changing channel settings', () => expect(() => requireAssistantManager(actor)).toThrow());
});
