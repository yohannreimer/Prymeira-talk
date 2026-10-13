import type { Prisma, PrismaClient } from '@prisma/client';
import { enterCanonicalWorkspaceTransaction } from '../messaging/canonical-boundary.js';
import { lockProspectingConversations } from '../prospecting/prospecting-lock.js';
import { whatsappPhoneCandidates } from '../leads/lead-whatsapp-numbers.js';
import { campaignCompanyName } from './campaign-message-render.js';
import { record as asRecord } from '../messaging/whatsapp-identity.js';

/** Explicit paused campaigns only. Preserve before-images and every UUID.
 * Never resume queues, send messages or replay older customer replies. */
export async function repairPausedProspecting(db: PrismaClient, input: {
  workspaceId: string; campaignNames: string[]; apply?: boolean;
}) {
  if (!input.campaignNames.length || new Set(input.campaignNames).size !== input.campaignNames.length) throw new Error('Explicit unique campaign names required');
  return db.$transaction(async tx => {
    if (!input.apply) await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    else await enterCanonicalWorkspaceTransaction(tx, input.workspaceId);
    const campaigns = await tx.campaign.findMany({ where: { workspaceId: input.workspaceId, name: { in: input.campaignNames } } });
    if (campaigns.length !== input.campaignNames.length || campaigns.some(c => c.status !== 'paused' || !c.prospectingAgentId)) throw new Error('Every selected prospecting campaign must be uniquely identified and paused');
    const recipients = await tx.campaignRecipient.findMany({ where: { workspaceId: input.workspaceId,
      campaignId: { in: campaigns.map(c => c.id) } }, orderBy: [{ campaignId: 'asc' }, { sequenceNumber: 'asc' }] });
    if (recipients.some(r => r.status === 'in_flight' || r.status === 'uncertain')) throw new Error('Unresolved send requires review first');
    const changes: Array<Record<string, unknown>> = [], skipped: Array<{ recipientId: string; reason: string }> = [];
    for (const recipient of recipients) {
      const snapshot = asRecord(recipient.contactSnapshot), fields = asRecord(snapshot.fields);
      if (recipient.status === 'pending') {
        const company = typeof fields.empresa === 'string' ? fields.empresa : typeof fields.company === 'string' ? fields.company : null;
        const short = company ? campaignCompanyName(company) : null;
        if (company && short && short !== company && typeof snapshot.message === 'string' && snapshot.message.includes(company)) {
          const next = { ...snapshot, message: snapshot.message.replaceAll(company, short) };
          changes.push({ kind: 'short_company', recipientId: recipient.id, before: recipient.contactSnapshot, after: next });
          if (input.apply) await tx.campaignRecipient.update({ where: { id: recipient.id }, data: { contactSnapshot: next as Prisma.InputJsonObject } });
        }
        continue;
      }
      if (recipient.status !== 'sent' || !recipient.channelId || !recipient.providerMessageId) continue;
      const reservation = await tx.campaignProspectingReservation.findUnique({ where: { workspaceId_recipientId: { workspaceId: input.workspaceId, recipientId: recipient.id } } });
      if (!reservation) continue;
      const identities = await tx.canonicalMessageIdentity.findMany({ where: { workspaceId: input.workspaceId,
        channelId: recipient.channelId, rawId: recipient.providerMessageId, direction: 'outbound', state: 'active' }, include: { conversation: { include: { contact: true } } } });
      if (identities.length !== 1 || identities[0]!.conversationId === reservation.conversationId) continue;
      const identity = identities[0]!, operating = identity.conversation;
      const dispatches = await tx.outboundDispatch.findMany({ where: { workspaceId: input.workspaceId, channelId: recipient.channelId,
        providerMessageId: recipient.providerMessageId, state: 'accepted' } });
      const old = await tx.conversation.findFirstOrThrow({ where: { workspaceId: input.workspaceId, id: reservation.conversationId }, include: { contact: true, messages: true } });
      const key = whatsappPhoneCandidates(operating.contact.phone)?.key;
      const proof = key && whatsappPhoneCandidates(old.contact.phone)?.key === key && dispatches.length === 1
        && whatsappPhoneCandidates(dispatches[0]!.destination)?.key === key;
      const duplicate = old.messages.length === 1 ? old.messages[0] : null;
      const realOutbounds = await tx.message.count({ where: { workspaceId: input.workspaceId, conversationId: operating.id, direction: 'outbound' } });
      if (!proof || reservation.status !== 'confirmed' || reservation.pendingInboundMessageId || reservation.latestInboundMessageId
        || old.activeAgentSessionId || operating.activeAgentSessionId || operating.assignedUserId || operating.aiControlUpdatedById
        || operating.status === 'closed' || realOutbounds !== 1 || !duplicate
        || duplicate.providerEventId !== `campaign:${recipient.id}` || duplicate.providerMessageId !== recipient.providerMessageId
        || await tx.canonicalMessageIdentity.count({ where: { workspaceId: input.workspaceId, messageId: duplicate.id } })) {
        skipped.push({ recipientId: recipient.id, reason: 'insufficient_exact_proof_or_human_activity' }); continue;
      }
      if (input.apply) await lockProspectingConversations(tx, [old.id, operating.id].map(conversationId => ({ workspaceId: input.workspaceId, conversationId })));
      const shortName = campaignCompanyName(old.contact.company || old.contact.name || 'empresa');
      changes.push({ kind: 'conversation_binding', recipientId: recipient.id, oldConversationId: old.id,
        conversationId: operating.id, duplicateMessageId: duplicate.id, canonicalMessageId: identity.messageId,
        before: { recipient, reservation, duplicate, oldConversation: { ...old, messages: undefined },
          operatingConversation: { ...operating, contact: undefined } }, name: shortName });
      if (input.apply) {
        await tx.message.update({ where: { id: duplicate.id }, data: { metadata: { ...asRecord(duplicate.metadata),
          campaignDuplicateAudit: true, duplicateOfMessageId: identity.messageId } } });
        await tx.campaignRecipient.update({ where: { id: recipient.id }, data: { contactId: operating.contactId } });
        await tx.campaignProspectingReservation.update({ where: { id: reservation.id }, data: { conversationId: operating.id, contactId: operating.contactId } });
        await tx.conversation.update({ where: { id: old.id }, data: { retiredIntoConversationId: operating.id, aiControlStatus: 'human_controlled' } });
        await tx.conversation.update({ where: { id: operating.id }, data: { aiControlStatus: 'agent_allowed', hiddenUntilReply: false } });
        if (!operating.contact.name?.trim()) await tx.contact.update({ where: { id: operating.contactId }, data: { name: shortName } });
      }
    }
    if (input.apply && changes.length) await tx.auditLog.create({ data: { workspaceId: input.workspaceId,
      action: 'paused_prospecting_identity_repair', targetType: 'campaign', metadata: JSON.parse(JSON.stringify({ campaignIds: campaigns.map(c => c.id), changes })) } });
    return { applied: !!input.apply, campaigns: campaigns.map(c => ({ id: c.id, name: c.name, status: c.status })),
      sent: recipients.filter(r => r.status === 'sent').length, pending: recipients.filter(r => r.status === 'pending').length,
      changes: changes.map(({ before: _before, after: _after, ...summary }) => summary), skipped };
  }, { timeout: 30_000 });
}
