import type { PrismaClient, Prisma } from '@prisma/client';
import type { ExtensionChat, ExtensionConversation } from '@prymeira-talk/shared';
import { AssistantError, resolveAssistantActor, requireAssistantConversation } from '../assistant/assistant-access.js';
import { buildPhoneLookupCandidates, normalizePhoneForStorage } from '../contacts/phone-normalization.js';
import { normalizeChatAddress, parseWahaMessageKey } from '../messaging/whatsapp-identity.js';
import { equal, sha, stable } from '../messaging/canonical-values.js';

type Db = PrismaClient | Prisma.TransactionClient;
type Auth = Parameters<typeof resolveAssistantActor>[1];
const failure = (code: string, message: string, status = 409): never => { throw new AssistantError(code, message, status); };

export async function listExtensionChannels(db: Db, auth: Auth) {
  await resolveAssistantActor(db, auth);
  const channels = await db.channel.findMany({ where: { workspaceId: auth.workspaceId, archivedAt: null,
    status: 'connected', verifiedMessagingPhoneNumber: { not: null } }, orderBy: { createdAt: 'asc' },
    select: { id: true, displayName: true, verifiedMessagingPhoneNumber: true, status: true } });
  return { workspaceId: auth.workspaceId, role: auth.role, channels: channels.map(c => ({ id: c.id,
    displayName: c.displayName, phoneNumber: c.verifiedMessagingPhoneNumber!, status: c.status })) };
}

/** Read-only resolver. Never creates contacts, merges aliases or chooses a new authority. */
export async function resolveExtensionConversation(db: Db, auth: Auth, input: ExtensionChat): Promise<ExtensionConversation> {
  const actor = await resolveAssistantActor(db, auth);
  const self = normalizeChatAddress(input.selfAddress), peer = normalizeChatAddress(input.peerAddress);
  if (!self?.endsWith('@s.whatsapp.net') || !peer || peer.endsWith('@g.us'))
    return failure('EXTENSION_IDENTITY_UNAVAILABLE', 'Abra uma conversa individual com identificação disponível.');
  const channel = await db.channel.findFirst({ where: { workspaceId: actor.workspaceId, id: input.channelId, archivedAt: null } });
  if (!channel) return failure('EXTENSION_CHANNEL_NOT_FOUND', 'Canal não disponível para esta conta.', 404);
  if (channel.status !== 'connected' || !channel.verifiedMessagingPhoneNumber)
    return failure('EXTENSION_CHANNEL_UNVERIFIED', 'O canal precisa estar conectado e com o número verificado no Talk.');
  if (normalizePhoneForStorage(channel.verifiedMessagingPhoneNumber) !== self.split('@')[0])
    return failure('EXTENSION_NUMBER_MISMATCH', 'O número do WhatsApp Web é diferente do canal selecionado.');
  const scope = { workspaceId: actor.workspaceId, channelId: channel.id };
  const alias = await db.canonicalAddressAlias.findUnique({ where: { workspaceId_channelId_address: { ...scope, address: peer } } });
  let conversationId: string | null = null;
  let canonicalChatId: string | null = null;
  if (alias) {
    let addressId: string | null = alias.addressId;
    const seen = new Set<string>();
    while (addressId) {
      if (seen.has(addressId) || seen.size >= 32) return failure('EXTENSION_IDENTITY_REVIEW', 'A identidade desta conversa precisa de revisão no Talk.');
      seen.add(addressId);
      const address: { id: string; state: string; redirectId: string | null } | null = await db.canonicalAddress.findFirst({ where: { ...scope, id: addressId },
        select: { id: true, state: true, redirectId: true } });
      if (!address || address.state === 'review') return failure('EXTENSION_IDENTITY_REVIEW', 'A identidade desta conversa precisa de revisão no Talk.');
      if (address.redirectId) { addressId = address.redirectId; continue; }
      const chat = await db.canonicalChat.findFirst({ where: { ...scope, addressId: address.id } });
      if (!chat || chat.state !== 'active' || !chat.operationConversationId)
        return failure('EXTENSION_IDENTITY_REVIEW', 'Resolva o vínculo desta conversa no Talk antes de continuar.');
      conversationId = chat.operationConversationId;
      canonicalChatId = chat.id;
      break;
    }
  } else if (peer.endsWith('@s.whatsapp.net')) {
    // Legacy channels: exact phone aliases only, within this channel. Names are never lookup keys.
    const candidates = await db.conversation.findMany({ where: { ...scope, retiredIntoConversationId: null,
      contact: { isGroup: false, phone: { in: buildPhoneLookupCandidates(peer.split('@')[0]!) } } }, select: { id: true }, take: 2 });
    if (candidates.length > 1) return failure('EXTENSION_AMBIGUOUS', 'Há mais de uma conversa correspondente. Resolva o vínculo no Talk.');
    conversationId = candidates[0]?.id ?? null;
  }
  if (!conversationId) return failure('EXTENSION_CONVERSATION_NOT_FOUND', 'Esta conversa ainda não foi identificada no Talk.', 404);
  const conversation = await requireAssistantConversation(db, actor, conversationId);
  if (conversation.channelId !== channel.id || conversation.retiredIntoConversationId)
    return failure('EXTENSION_IDENTITY_REVIEW', 'O vínculo da conversa mudou. Atualize o painel.');
  const contact = await db.contact.findFirst({ where: { workspaceId: actor.workspaceId, id: conversation.contactId }, select: { name: true, phone: true, isGroup: true } });
  if (!contact || contact.isGroup) return failure('EXTENSION_CONVERSATION_NOT_FOUND', 'Conversa individual indisponível.', 404);
  if (input.lastMessageId) {
    const key = parseWahaMessageKey(input.lastMessageId);
    if (!key.rawId || key.chatAddress !== peer || !key.direction)
      return failure('EXTENSION_INVALID_ANCHOR', 'A identificação da mensagem mudou. Atualize a conversa.');
    let observed: boolean;
    if (canonicalChatId) {
      // Canonical ingress deliberately leaves Message.providerMessageId empty. Match its indexed,
      // complete chat-scoped identity instead of treating an already-synced message as missing.
      const tuple = [actor.workspaceId, channel.id, canonicalChatId, 'whatsapp_stanza', '', key.rawId, key.direction, ''];
      const bucket = await db.canonicalMessageIdentity.findMany({ where: { ...scope, tupleHash: sha(stable(tuple)) },
        select: { fullTuple: true, state: true, contentState: true, message: { select: { hiddenByReset: true } } } });
      observed = bucket.filter(identity => equal(identity.fullTuple, tuple) && identity.state === 'active'
        && identity.contentState === 'ready' && !identity.message.hiddenByReset).length === 1;
    } else {
      observed = !!await db.message.findFirst({ where: { workspaceId: actor.workspaceId,
        direction: key.direction, conversation: { ...scope, OR: [{ id: conversation.id }, { retiredIntoConversationId: conversation.id }] },
        providerMessageId: { in: [key.rawId, input.lastMessageId] } }, select: { id: true } });
    }
    if (!observed) return failure('EXTENSION_SYNC_PENDING', 'Aguardando esta mensagem chegar ao Talk. O painel atualizará automaticamente.');
  }
  return { id: conversation.id, contactName: contact.name, phone: contact.phone, channelId: channel.id };
}
