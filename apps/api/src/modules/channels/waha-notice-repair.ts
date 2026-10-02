import type { PrismaClient } from '@prisma/client';
import { enterCanonicalWorkspaceTransaction } from '../messaging/canonical-boundary.js';

const UNRECOGNIZED = 'Mensagem não reconhecida';

export type WahaNoticeRepairResult = { candidates: number; removed: number; skipped: number; hiddenConversations: number; refreshedConversations: number };

/**
 * One-off repair for WhatsApp notices (encryption notice, "waiting for this message", call log...) that WAHA history
 * or gap recovery wrote as inbound "Mensagem não reconhecida" before they were filtered at normalization.
 *
 * Only messages that WAHA alone observed, in history or recovered mode, are touched; anything seen live, by Evolution
 * or referenced by an outbound or ingress fact stays. A conversation left without messages is hidden until the next
 * real message; one with messages gets its preview and activity back from its newest remaining message.
 */
export async function repairWahaNotices(prisma: PrismaClient, input: { workspaceId: string; apply: boolean }): Promise<WahaNoticeRepairResult> {
  const { workspaceId } = input;
  const candidates = await prisma.$queryRaw<Array<{ id: string; conversation_id: string; channel_id: string }>>`
    SELECT m.id, m.conversation_id, c.channel_id
    FROM messages m JOIN conversations c ON c.workspace_id = m.workspace_id AND c.id = m.conversation_id
    JOIN canonical_message_identities i ON i.message_id = m.id
    WHERE m.workspace_id = ${workspaceId} AND m.type = 'system' AND m.body = ${UNRECOGNIZED}
      AND EXISTS (SELECT 1 FROM canonical_observations o WHERE o.identity_id = i.id)
      AND NOT EXISTS (SELECT 1 FROM canonical_observations o WHERE o.identity_id = i.id
        AND (o.connection_provider IS DISTINCT FROM 'waha' OR o.mode NOT IN ('history', 'recovered_live')))
      AND NOT EXISTS (SELECT 1 FROM ingress_event_progress p WHERE p.workspace_id = m.workspace_id AND p.message_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM ingress_effects e WHERE e.workspace_id = m.workspace_id AND e.message_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM outbound_intents x WHERE x.workspace_id = m.workspace_id AND x.message_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM outbound_bindings b WHERE b.workspace_id = m.workspace_id AND b.identity_id = i.id)`;
  const result: WahaNoticeRepairResult = { candidates: candidates.length, removed: 0, skipped: 0, hiddenConversations: 0, refreshedConversations: 0 };
  if (!input.apply) return result;
  const conversations = new Map<string, string>();
  for (const message of candidates) {
    try {
      await prisma.$transaction(async tx => {
        await enterCanonicalWorkspaceTransaction(tx, workspaceId);
        const [identity] = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM canonical_message_identities WHERE workspace_id = ${workspaceId} AND message_id = ${message.id}::uuid`;
        if (identity) {
          const aliases = await tx.$queryRaw<Array<{ alias_id: string }>>`SELECT DISTINCT alias_id FROM canonical_observations WHERE workspace_id = ${workspaceId} AND identity_id = ${identity.id}::uuid AND alias_id IS NOT NULL`;
          await tx.$executeRaw`DELETE FROM canonical_observations WHERE workspace_id = ${workspaceId} AND identity_id = ${identity.id}::uuid`;
          for (const { alias_id } of aliases) {
            await tx.$executeRaw`DELETE FROM canonical_native_aliases a WHERE a.workspace_id = ${workspaceId} AND a.id = ${alias_id}::uuid
              AND NOT EXISTS (SELECT 1 FROM canonical_observations o WHERE o.workspace_id = a.workspace_id AND o.alias_id = a.id)`;
          }
          await tx.$executeRaw`UPDATE canonical_native_aliases SET identity_id = NULL WHERE workspace_id = ${workspaceId} AND identity_id = ${identity.id}::uuid`;
          await tx.$executeRaw`DELETE FROM canonical_actions WHERE workspace_id = ${workspaceId} AND identity_id = ${identity.id}::uuid`;
        }
        // The identity, recipient receipts, preview owner and media rows go with the message (ON DELETE CASCADE).
        await tx.$executeRaw`DELETE FROM messages WHERE workspace_id = ${workspaceId} AND id = ${message.id}::uuid`;
      }, { isolationLevel: 'ReadCommitted', timeout: 30_000 });
      result.removed++;
      conversations.set(message.conversation_id, message.channel_id);
    } catch { result.skipped++; }
  }
  for (const conversationId of conversations.keys()) {
    const latest = await prisma.message.findFirst({ where: { workspaceId, conversationId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    await prisma.$transaction(async tx => {
      await enterCanonicalWorkspaceTransaction(tx, workspaceId);
      if (!latest) {
        await tx.conversation.update({ where: { workspaceId_id: { workspaceId, id: conversationId } },
          data: { lastMessagePreview: null, lastMessagePreviewAt: null, lastMessageAt: null, unreadCount: 0, hiddenUntilReply: true } });
        result.hiddenConversations++;
        return;
      }
      // The preview cache is written first; its owner row proves which message it shows (the trigger clears it on write).
      const conversation = await tx.conversation.update({ where: { workspaceId_id: { workspaceId, id: conversationId } },
        data: { lastMessagePreview: latest.body, lastMessagePreviewAt: latest.createdAt, lastMessageAt: latest.createdAt } });
      await tx.conversationPreviewOwner.create({ data: { workspaceId, channelId: conversation.channelId, conversationId, messageId: latest.id } });
      result.refreshedConversations++;
    }, { isolationLevel: 'ReadCommitted', timeout: 30_000 });
  }
  return result;
}
