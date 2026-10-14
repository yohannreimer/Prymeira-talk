import { PrismaClient } from '@prisma/client';
import { normalizeWhatsappPhone } from './modules/channels/channel-connections.js';
import { record } from './modules/messaging/whatsapp-identity.js';

/** Explicit, bounded operator retry. Unsupported attachments and pending autonomous effects are preserved;
 * an available provider is a prerequisite, not proof that its historical bytes still exist. */
const [workspaceId, ...flags] = process.argv.slice(2);
const apply = flags.includes('--apply');
const hours = Number(flags.find(f => f.startsWith('--hours='))?.slice(8) ?? 48);
const limit = Number(flags.find(f => f.startsWith('--limit='))?.slice(8) ?? 20);
if (!workspaceId || !Number.isFinite(hours) || hours <= 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('Usage: requeue-media <workspace-id> [--hours=48] [--limit=20] [--apply]');
const db = new PrismaClient();
try {
  const rows = await db.ingressEffect.findMany({ where: { workspaceId, kind: 'media.prepare', state: 'failed', createdAt: { gte: new Date(Date.now() - hours * 60 * 60_000) } }, orderBy: { createdAt: 'asc' }, take: 200 });
  const dispositions: Record<string, number> = {}; let requeued = 0, eligible = 0;
  for (const row of rows) {
    let disposition = 'eligible';
    if (!['MEDIA_UNAVAILABLE', 'MEDIA_TIMEOUT'].includes(row.lastErrorCode ?? '')) disposition = 'unsupported_or_other_failure';
    const source = record(record(row.frozen).mediaSource);
    if (disposition === 'eligible') {
      const media = row.messageId ? await db.messageMedia.findFirst({ where: { workspaceId, messageId: row.messageId } }) : null;
      if (media?.state === 'stored') disposition = 'already_stored';
      if (disposition === 'eligible' && (!['waha', 'evolution'].includes(String(source.provider)) || typeof source.sessionName !== 'string')) disposition = 'source_requires_audit';
      if (disposition === 'eligible') {
        const connection = await db.channelConnection.findFirst({ where: { workspaceId, channelId: row.channelId, provider: source.provider as 'waha' | 'evolution', sessionName: source.sessionName as string, status: 'connected', eligible: true, channel: { archivedAt: null } } });
        if (!connection || connection.lifecycleGeneration % 2 !== 0) disposition = 'source_unavailable';
        else {
          const receipt = await db.ingressReceipt.findFirst({ where: { id: row.receiptId, workspaceId, channelId: row.channelId }, select: { source: true } });
          const original = record(receipt?.source), accepted = normalizeWhatsappPhone(record(original.acceptedFacts).verifiedPhoneNumber as string | null | undefined);
          if (!accepted || accepted !== normalizeWhatsappPhone(connection.verifiedPhoneNumber) || original.sessionName !== connection.sessionName || original.provider !== connection.provider) disposition = 'number_or_session_unproven';
        }
      }
      if (disposition === 'eligible' && await db.ingressEffect.count({ where: { workspaceId, receiptId: row.receiptId, eventIndex: row.eventIndex, state: { in: ['pending', 'running'] }, kind: { in: ['agent.debounce', 'assistant.message', 'automation.occurrence', 'prospecting.inbound'] } } })) disposition = 'autonomous_effect_requires_review';
    }
    dispositions[disposition] = (dispositions[disposition] ?? 0) + 1;
    if (disposition === 'eligible' && eligible++ < limit && apply) requeued += (await db.ingressEffect.updateMany({ where: { id: row.id, workspaceId, state: 'failed' }, data: { state: 'pending', attempts: 0, nextAttemptAt: new Date(), completedAt: null, lastErrorCode: null } })).count;
  }
  console.info(JSON.stringify({ hours, limit, apply, examined: rows.length, dispositions, eligible, requeued }));
} finally { await db.$disconnect(); }
