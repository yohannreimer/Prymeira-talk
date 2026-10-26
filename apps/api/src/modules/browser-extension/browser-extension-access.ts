import type { PrismaClient, Prisma } from '@prisma/client';
import type { ExtensionAccount } from '@prymeira-talk/shared';
import { AssistantError, resolveAssistantActor } from '../assistant/assistant-access.js';
import { normalizeChatAddress } from '../messaging/whatsapp-identity.js';
import { normalizePhoneForStorage } from '../contacts/phone-normalization.js';
export type ExtensionDb = PrismaClient | Prisma.TransactionClient;
export type ExtensionAuth = Parameters<typeof resolveAssistantActor>[1];
export async function requireExtensionAccount(db: ExtensionDb, auth: ExtensionAuth, account: ExtensionAccount) {
  const actor = await resolveAssistantActor(db, auth);
  const self = normalizeChatAddress(account.selfAddress);
  if (!self?.endsWith('@s.whatsapp.net')) throw new AssistantError('EXTENSION_IDENTITY_UNAVAILABLE', 'Entre no WhatsApp Web com um número identificável.');
  const channel = await db.channel.findFirst({ where: { workspaceId: actor.workspaceId, id: account.channelId, archivedAt: null } });
  if (!channel) throw new AssistantError('EXTENSION_CHANNEL_NOT_FOUND', 'Canal não disponível para esta conta.', 404);
  if (channel.status !== 'connected' || !channel.verifiedMessagingPhoneNumber) throw new AssistantError('EXTENSION_CHANNEL_UNVERIFIED', 'O canal precisa estar conectado e verificado no Talk.');
  if (normalizePhoneForStorage(channel.verifiedMessagingPhoneNumber) !== self.split('@')[0]) throw new AssistantError('EXTENSION_NUMBER_MISMATCH', 'O número do WhatsApp Web é diferente do canal selecionado.');
  return { actor, channel };
}
