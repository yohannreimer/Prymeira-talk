import { describe, expect, it, vi } from 'vitest';
import { AGENT_REPLY_LEASE_MS, recoverStaleAgentReplyClaim } from './agent-reply-claim.js';

function fixture() {
  const now = new Date('2026-10-15T12:00:00Z');
  const reply = { id: 'reply', workspaceId: 'workspace', conversationId: 'conversation', agentId: 'agent',
    sessionId: 'session', lastMessageId: 'message', prospectingGeneration: null as string | null,
    status: 'processing', claimToken: 'token', lockedAt: new Date(now.getTime() - AGENT_REPLY_LEASE_MS - 1) };
  const session = { id: 'session', agentId: 'agent', status: 'active', prospectingGeneration: null as string | null };
  const conversation = { id: 'conversation', workspaceId: 'workspace', activeAgentSessionId: 'session',
    aiControlStatus: 'agent_allowed', activeAgentSession: session };
  const tx: any = {
    $queryRaw: vi.fn(async () => [{ isolation: 'read committed' }]), $executeRaw: vi.fn(async () => 1),
    aiAgentPendingReply: { findUnique: vi.fn(async () => ({ ...reply })),
      update: vi.fn(async ({ data }) => Object.assign(reply, data)) },
    conversation: { findUnique: vi.fn(async () => conversation),
      update: vi.fn(async ({ data }) => Object.assign(conversation, data)) },
    aiAgentSession: { update: vi.fn(async ({ data }) => Object.assign(session, data)) },
    message: { findFirst: vi.fn(async () => ({ id: 'message', hiddenByReset: false })), findMany: vi.fn(async () => []) }
  };
  const db: any = { $transaction: vi.fn(async work => work(tx)) };
  return { now, reply, session, conversation, tx, db };
}

describe('stale reply failure handoff', () => {
  it.each(['none', 'prepared'])('does not replay an interrupted prospecting claim at %s dispatch phase', async phase => {
    const f = fixture(); f.reply.prospectingGeneration = 'generation'; f.session.prospectingGeneration = 'generation';
    f.tx.campaignProspectingReservation = { findUnique: vi.fn(async () => ({ generation: 'generation', recipientId: 'recipient' })),
      updateMany: vi.fn(async () => ({ count: 1 })) };
    for (const delegate of [f.tx.aiAgentSession, f.tx.conversation, f.tx.aiAgentPendingReply]) delegate.updateMany = vi.fn(async () => ({ count: 1 }));
    f.tx.conversationFollowup = { updateMany: vi.fn(async () => ({ count: 0 })) };
    f.tx.message.findMany.mockResolvedValue(phase === 'none' ? [] : [{ metadata: { prospectingDispatch: 'prepared' } }]);
    const recovered = await recoverStaleAgentReplyClaim(f.db, { ...f.reply }, f.now);
    expect(recovered?.status).toBe('failed');
    expect(f.conversation.aiControlStatus).toBe('human_controlled');
    expect(f.session.status).toBe('handoff_requested');
  });

  it('atomically hands an ordinary uncertain reply to the matching human queue', async () => {
    const f = fixture();
    const recovered = await recoverStaleAgentReplyClaim(f.db, { ...f.reply }, f.now);
    expect(f.reply.status).toBe('failed');
    expect(f.conversation.aiControlStatus).toBe('human_controlled');
    expect(f.session.status).toBe('handoff_requested');
    expect(recovered).toMatchObject({ handoff: { workspaceId: 'workspace', conversationId: 'conversation',
      sessionId: 'session', agentId: 'agent', messageId: 'message' } });
    expect(f.db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'ReadCommitted' });
  });

  it.each(['replacement_claim', 'renewed_claim', 'replacement_session', 'hidden_anchor'])('preserves %s while recovering an old snapshot', async change => {
    const f = fixture(), snapshot = { ...f.reply };
    if (change === 'replacement_claim') f.reply.claimToken = 'new-token';
    if (change === 'renewed_claim') f.reply.lockedAt = f.now;
    if (change === 'replacement_session') f.conversation.activeAgentSessionId = 'new-session';
    if (change === 'hidden_anchor') f.tx.message.findFirst.mockResolvedValue(null);
    await recoverStaleAgentReplyClaim(f.db, snapshot, f.now);
    expect(f.conversation.aiControlStatus).toBe('agent_allowed');
    expect(f.session.status).toBe('active');
    if (change === 'replacement_claim' || change === 'renewed_claim') expect(f.reply.status).toBe('processing');
  });
});
