import type { PrismaClient } from '@prisma/client';
import { normalizeWhatsappPhone } from '../channels/channel-connections.js';
/** Never poll a known unavailable Evolution instance or borrow media from a different pairing. */
export async function eligibleEvolutionMediaInstance(db: PrismaClient, workspaceId: string, messageId: string) {
  const message = await db.message.findFirst({ where: { workspaceId, id: messageId }, select: { conversation: { select: { channelId: true } } } });
  const channelId = message?.conversation.channelId;
  if (!channelId) return null;
  const connections = await db.channelConnection.findMany({ where: { workspaceId, channelId, channel: { archivedAt: null } } });
  const primary = connections.find(c => c.provider === 'evolution'), secondary = connections.find(c => c.provider === 'waha');
  const a = normalizeWhatsappPhone(primary?.verifiedPhoneNumber), b = normalizeWhatsappPhone(secondary?.verifiedPhoneNumber);
  if (!primary || primary.status !== 'connected' || !primary.eligible || primary.lifecycleGeneration % 2 !== 0 || !a || a !== b || !secondary || secondary.lifecycleGeneration % 2 !== 0) return null;
  return primary.sessionName;
}
