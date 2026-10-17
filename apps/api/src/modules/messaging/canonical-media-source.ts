import type { PrismaClient } from '@prisma/client';
import { completeProviderKey } from './provider-exact.js';
import { record, type WhatsAppMessageKey } from './whatsapp-identity.js';

/** null means a legacy message. A known canonical identity must never be downgraded
 * to an ID-only lookup: its resolved provider observation supplies the complete native key. */
export async function canonicalEvolutionMediaKey(db: Partial<Pick<PrismaClient, 'canonicalMessageIdentity'>>, input: {
  workspaceId: string; messageId: string; channelId?: string; instanceName: string;
}): Promise<WhatsAppMessageKey | null> {
  if (!db.canonicalMessageIdentity) return null;
  const identity = await db.canonicalMessageIdentity.findFirst({ where: {
    workspaceId: input.workspaceId, messageId: input.messageId, ...(input.channelId ? { channelId: input.channelId } : {})
  }, include: { observations: { where: { kind: 'message', state: 'resolved', provider: 'evolution', sessionName: input.instanceName }, orderBy: { receivedAt: 'desc' }, take: 1 } } });
  if (!identity) return null;
  const key = record(identity.observations[0]?.payload).key as WhatsAppMessageKey | undefined;
  if (identity.state !== 'active' || !key || !completeProviderKey(key) || key.direction !== identity.direction || (key.rawId ?? key.nativeId) !== identity.rawId) throw new Error('MEDIA_IDENTITY_UNAVAILABLE');
  return key;
}
