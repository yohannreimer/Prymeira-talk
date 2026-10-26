import { describe, expect, it, vi } from 'vitest';
import { executeExtensionCommand } from './extension-bridge';
const channelId = '00000000-0000-4000-8000-000000000001', conversationId = '00000000-0000-4000-8000-000000000002';
const followupId = '00000000-0000-4000-8000-000000000003', updatedAt = '2026-10-26T10:00:00.000Z';
const chat = { channelId, selfAddress: 'self', peerAddress: 'peer' };
function requestWith(followup: unknown = null) {
  return vi.fn(async (path: string) => {
    if (path === '/browser-extension/channels') return { workspaceId: 'w', role: 'owner', channels: [{ id: channelId }] };
    if (path === '/browser-extension/resolve') return { id: conversationId };
    if (path.endsWith('/followup')) return { followup };
    if (path.startsWith('/assistant/')) return { status: 'ready' };
    return {};
  });
}
describe('authenticated Talk bridge allowlist', () => {
  it('reuses the existing APIs after resolving identity and returns no credentials', async () => {
    const request = requestWith();
    const result = await executeExtensionCommand({ action: 'read', chat }, request as never, 'user-session');
    expect(result).toMatchObject({ ok: true, data: { scope: 'user-session:w:owner', conversation: { id: conversationId } } });
    expect(request.mock.calls.map(call => call[0])).toEqual(['/browser-extension/channels', '/browser-extension/resolve', `/conversations/${conversationId}/followup`, `/assistant/conversations/${conversationId}`]);
    expect(JSON.stringify(result)).not.toMatch(/Bearer|token|secret/i);
  });
  it('rejects arbitrary endpoints, send commands and caller-supplied workspace IDs', async () => {
    const request = requestWith();
    for (const command of [{ action: 'fetch', url: '/settings' }, { action: 'send', chat }, { action: 'read', chat, workspaceId: 'victim' }])
      await expect(executeExtensionCommand(command, request as never, 'user')).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('cannot mutate a follow-up from another conversation or an outdated revision', async () => {
    const request = requestWith({ id: 'different-followup', updatedAt });
    await expect(executeExtensionCommand({ action: 'followup', chat, id: followupId, operation: 'cancel', expectedUpdatedAt: updatedAt }, request as never, 'user')).rejects.toThrow('mudou');
    expect(request.mock.calls.some(([path]) => path.includes('/cancel'))).toBe(false);
  });
  it('uses optimistic concurrency and the existing cancellation endpoint', async () => {
    const request = requestWith({ id: followupId, updatedAt });
    expect(await executeExtensionCommand({ action: 'followup', chat, id: followupId, operation: 'cancel', expectedUpdatedAt: updatedAt }, request as never, 'user')).toMatchObject({ ok: true, data: { accepted: true } });
    expect(request).toHaveBeenLastCalledWith(`/followups/${followupId}/cancel`, { method: 'POST', body: JSON.stringify({ expectedUpdatedAt: updatedAt, reason: 'manual_cancelled' }) });
  });
});

it('queries queues and revalidates navigation through fixed read-only endpoints', async()=>{
  const request=requestWith();
  await executeExtensionCommand({action:'queue',account:{channelId,selfAddress:'self'},kind:'human'},request as never,'user');
  expect(request).toHaveBeenLastCalledWith('/browser-extension/queue',{method:'POST',body:JSON.stringify({account:{channelId,selfAddress:'self'},kind:'human'})});
  await executeExtensionCommand({action:'navigate',account:{channelId,selfAddress:'self'},kind:'human',id:conversationId},request as never,'user');
  expect(request).toHaveBeenLastCalledWith('/browser-extension/navigate',{method:'POST',body:JSON.stringify({account:{channelId,selfAddress:'self'},kind:'human',id:conversationId})});
  expect(request.mock.calls.some(([path])=>path.endsWith('/send'))).toBe(false);
});
