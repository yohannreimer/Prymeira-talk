import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listExtensionChannels, resolveExtensionConversation } from './browser-extension.service.js';
import { sha, stable } from '../messaging/canonical-values.js';

const channelId = '00000000-0000-4000-8000-000000000001', conversationId = '00000000-0000-4000-8000-000000000002';
const auth = { workspaceId: 'workspace-A', clerkUserId: 'user-A', role: 'owner' as const };
const input = { channelId, selfAddress: '5547991234567@c.us', peerAddress: '5547987654321@c.us' };
function database() {
  return { userProfile: { findFirst: vi.fn(async () => ({ id: 'profile-A' })) },
    channel: { findFirst: vi.fn(async () => ({ id: channelId, status: 'connected', verifiedMessagingPhoneNumber: '5547991234567' })), findMany: vi.fn(async () => []) },
    conversation: { findMany: vi.fn(async () => [{ id: conversationId }]), findFirst: vi.fn(async () => ({ id: conversationId, channelId,
      contactId: 'contact-A', assignedUserId: 'profile-A', retiredIntoConversationId: null })) },
    canonicalAddressAlias: { findUnique: vi.fn(async (): Promise<null | { addressId: string }> => null) },
    canonicalAddress: { findFirst: vi.fn(async (): Promise<{ id: string; state: string; redirectId: string | null }> => ({ id: 'address-A', state: 'active', redirectId: null })) },
    canonicalChat: { findFirst: vi.fn(async () => ({ state: 'active', operationConversationId: conversationId })) },
    canonicalMessageIdentity: { findMany: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []) },
    contact: { findFirst: vi.fn(async () => ({ name: 'Ana', phone: '554787654321', isGroup: false })) },
    message: { findFirst: vi.fn(async (): Promise<{ id: string } | null> => ({ id: 'message-A' })) } };
}
describe('browser extension read-only conversation resolver', () => {
  let db: ReturnType<typeof database>;
  beforeEach(() => { db = database(); });
  it('resolves within the authenticated workspace and selected channel', async () => {
    expect(await resolveExtensionConversation(db as never, auth, input)).toEqual({ id: conversationId, channelId, contactName: 'Ana', phone: '554787654321' });
    expect(db.channel.findFirst).toHaveBeenCalledWith({ where: { workspaceId: 'workspace-A', id: channelId, archivedAt: null } });
    expect(db.conversation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: 'workspace-A', channelId }) }));
  });
  it('refuses a number mismatch before any conversation lookup', async () => {
    await expect(resolveExtensionConversation(db as never, auth, { ...input, selfAddress: '5511987654321@c.us' })).rejects.toMatchObject({ code: 'EXTENSION_NUMBER_MISMATCH' });
    expect(db.conversation.findMany).not.toHaveBeenCalled();
  });
  it('does not interpret LID digits as a phone', async () => {
    await expect(resolveExtensionConversation(db as never, auth, { ...input, peerAddress: '123456789@lid' })).rejects.toMatchObject({ statusCode: 404 });
    expect(db.conversation.findMany).not.toHaveBeenCalled();
  });
  it('follows a proven LID redirect and existing conversation authority', async () => {
    db.canonicalAddressAlias.findUnique.mockResolvedValue({ addressId: 'old-address' });
    db.canonicalAddress.findFirst.mockResolvedValueOnce({ id: 'old-address', state: 'redirected', redirectId: 'address-A' });
    expect((await resolveExtensionConversation(db as never, auth, { ...input, peerAddress: '123456789@lid' })).id).toBe(conversationId);
    expect(db.conversation.findMany).not.toHaveBeenCalled();
    expect(db.canonicalAddress.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: 'workspace-A', channelId, id: 'address-A' }) }));
  });
  it('refuses conflicted aliases without falling back to a phone', async () => {
    db.canonicalAddressAlias.findUnique.mockResolvedValue({ addressId: 'address-A' });
    db.canonicalAddress.findFirst.mockResolvedValue({ id: 'address-A', state: 'review', redirectId: null });
    await expect(resolveExtensionConversation(db as never, auth, input)).rejects.toMatchObject({ code: 'EXTENSION_IDENTITY_REVIEW' });
    expect(db.conversation.findMany).not.toHaveBeenCalled();
  });
  it('refuses a redirect cycle', async () => {
    db.canonicalAddressAlias.findUnique.mockResolvedValue({ addressId: 'address-A' });
    db.canonicalAddress.findFirst.mockResolvedValue({ id: 'address-A', state: 'redirected', redirectId: 'address-A' });
    await expect(resolveExtensionConversation(db as never, auth, input)).rejects.toMatchObject({ code: 'EXTENSION_IDENTITY_REVIEW' });
  });
  it('does not choose between legacy duplicates', async () => {
    db.conversation.findMany.mockResolvedValue([{ id: 'first' }, { id: 'second' }]);
    await expect(resolveExtensionConversation(db as never, auth, input)).rejects.toMatchObject({ code: 'EXTENSION_AMBIGUOUS' });
  });
  it('enforces the existing assignment rule for agents', async () => {
    db.conversation.findFirst.mockResolvedValue({ id: conversationId, channelId, contactId: 'contact-A', assignedUserId: 'another-profile', retiredIntoConversationId: null });
    await expect(resolveExtensionConversation(db as never, { ...auth, role: 'agent' }, input)).rejects.toMatchObject({ statusCode: 403 });
    expect(db.contact.findFirst).not.toHaveBeenCalled();
  });
  it('waits for the observed WhatsApp message to be in the Talk history', async () => {
    db.message.findFirst.mockResolvedValue(null);
    await expect(resolveExtensionConversation(db as never, auth, { ...input, lastMessageId: 'false_5547987654321@c.us_stanza' })).rejects.toMatchObject({ code: 'EXTENSION_SYNC_PENDING' });
    expect(db.message.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: 'workspace-A', direction: 'inbound',
      providerMessageId: { in: ['stanza', 'false_5547987654321@c.us_stanza'] } }) }));
  });
  it('refuses a message anchor belonging to another peer', async () => {
    await expect(resolveExtensionConversation(db as never, auth, { ...input, lastMessageId: 'false_5511987654321@c.us_stanza' })).rejects.toMatchObject({ code: 'EXTENSION_INVALID_ANCHOR' });
    expect(db.message.findFirst).not.toHaveBeenCalled();
  });
  it('recognizes a canonical message whose legacy providerMessageId is null', async () => {
    db.canonicalAddressAlias.findUnique.mockResolvedValue({ addressId: 'address-A' });
    db.canonicalChat.findFirst.mockResolvedValue({ id: 'canonical-chat', state: 'active', operationConversationId: conversationId } as never);
    db.message.findFirst.mockResolvedValue(null);
    const fullTuple = ['workspace-A', channelId, 'canonical-chat', 'whatsapp_stanza', '', 'stanza', 'inbound', ''];
    db.canonicalMessageIdentity.findMany.mockResolvedValue([{ fullTuple, state: 'active', contentState: 'ready', message: { hiddenByReset: false } }]);
    expect((await resolveExtensionConversation(db as never, auth, { ...input, lastMessageId: 'false_5547987654321@c.us_stanza' })).id).toBe(conversationId);
    expect(db.canonicalMessageIdentity.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: 'workspace-A', channelId, tupleHash: sha(stable(fullTuple)) } }));
    expect(db.message.findFirst).not.toHaveBeenCalled();
  });
  it('rejects unready, hidden or differently scoped canonical anchors without legacy fallback', async () => {
    db.canonicalAddressAlias.findUnique.mockResolvedValue({ addressId: 'address-A' });
    db.canonicalChat.findFirst.mockResolvedValue({ id: 'canonical-chat', state: 'active', operationConversationId: conversationId } as never);
    const fullTuple = ['workspace-A', channelId, 'canonical-chat', 'whatsapp_stanza', '', 'stanza', 'inbound', ''];
    for (const change of [{ state: 'review' }, { contentState: 'pending_reconciliation' }, { message: { hiddenByReset: true } }, { fullTuple: ['other-workspace', ...fullTuple.slice(1)] }]) {
      db.canonicalMessageIdentity.findMany.mockResolvedValue([{ fullTuple, state: 'active', contentState: 'ready', message: { hiddenByReset: false }, ...change }]);
      await expect(resolveExtensionConversation(db as never, auth, { ...input, lastMessageId: 'false_5547987654321@c.us_stanza' })).rejects.toMatchObject({ code: 'EXTENSION_SYNC_PENDING' });
    }
    expect(db.message.findFirst).not.toHaveBeenCalled();
  });
  it('resolves a raw DOM stanza only through a unique active canonical authority', async () => {
    const rawId = '3EB0123456789ABCDEF0';
    const identity = { chatId: 'canonical-chat', direction: 'inbound', state: 'active', contentState: 'ready',
      fullTuple: ['workspace-A', channelId, 'canonical-chat', 'whatsapp_stanza', '', rawId, 'inbound', ''],
      message: { hiddenByReset: false }, chat: { state: 'active', operationConversationId: conversationId,
        address: { state: 'active', redirectId: null } } };
    db.canonicalMessageIdentity.findMany.mockResolvedValue([identity]);
    expect((await resolveExtensionConversation(db as never, auth, { ...input, peerAddress: null, lastMessageId: rawId } as never)).id).toBe(conversationId);
    expect(db.canonicalMessageIdentity.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      workspaceId: 'workspace-A', channelId, identityFormat: 'whatsapp_stanza', providerScope: '', rawId }, take: 2 }));
    expect(db.conversation.findMany).not.toHaveBeenCalled();
    for (const invalid of [[], [identity, identity], [{ ...identity, state: 'review' }],
      [{ ...identity, message: { hiddenByReset: true } }], [{ ...identity, contentState: 'pending_reconciliation' }],
      [{ ...identity, chat: { ...identity.chat, address: { state: 'review', redirectId: null } } }],
      [{ ...identity, fullTuple: ['other-workspace', ...identity.fullTuple.slice(1)] }]]) {
      db.canonicalMessageIdentity.findMany.mockResolvedValue(invalid);
      await expect(resolveExtensionConversation(db as never, auth, { ...input, peerAddress: null, lastMessageId: rawId } as never)).rejects.toBeDefined();
    }
    expect(db.message.findFirst).not.toHaveBeenCalled();
  });
  it('lists only connected channels with provider-verified phone identities', async () => {
    await listExtensionChannels(db as never, auth);
    expect(db.channel.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: auth.workspaceId, archivedAt: null, status: 'connected', verifiedMessagingPhoneNumber: { not: null } } }));
  });
});
