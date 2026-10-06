import { lockProspectingConversation, lockProspectingConversations } from "../prospecting/prospecting-lock.js";
import { validateProspectingAgent } from "../prospecting/prospecting-policy.js";
import { activateConfirmedProspecting } from "../prospecting/prospecting-lifecycle.js";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export function createCampaignWorkerRepository(prisma: PrismaClient, options: {
  now?: () => Date;
  leaseMs?: number;
} = {}) {
  const now = options.now ?? (() => new Date());
  const leaseMs = options.leaseMs ?? 90_000;
  return {
    async claimDue() {
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT r.id FROM campaign_recipients r
          JOIN campaigns c ON c.id = r.campaign_id AND c.workspace_id = r.workspace_id
          JOIN campaign_channel_throttles t
            ON t.workspace_id = r.workspace_id AND t.channel_id = r.channel_id
          WHERE r.status = 'pending' AND r.scheduled_at <= (${now()}::timestamptz AT TIME ZONE 'UTC')
            AND c.status IN ('scheduled', 'sending')
            AND (t.next_available_at IS NULL OR t.next_available_at <= (${now()}::timestamptz AT TIME ZONE 'UTC'))
            AND NOT EXISTS (
              SELECT 1 FROM campaign_recipients active
              WHERE active.workspace_id = r.workspace_id
                AND active.channel_id = r.channel_id AND active.status IN ('in_flight', 'uncertain')
            )
          ORDER BY r.scheduled_at, r.sequence_number NULLS LAST, r.id
          FOR UPDATE OF r, t SKIP LOCKED LIMIT 1
        `;
        const id = rows[0]?.id;
        if (!id) return null;
        const leaseToken = randomUUID();
        const recipient = await tx.campaignRecipient.update({
          where: { id }, data: { status: "in_flight", leaseToken,
            leaseExpiresAt: new Date(now().getTime() + leaseMs) },
          include: { campaign: true }
        });
        if (recipient.campaign.status === "scheduled") {
          await tx.campaign.update({ where: { id: recipient.campaignId },
            data: { status: "sending" } });
        }
        return recipient;
      });
    },

    async returnPending(input: { id: string; leaseToken: string; scheduledAt?: Date;
      pauseCampaign?: boolean; reason?: string }) {
      return prisma.$transaction(async (tx) => {
        const current = await tx.campaignRecipient.findUniqueOrThrow({ where: { id: input.id }, include: { campaign: true } });
        const reservation = tx.campaignProspectingReservation ? await tx.campaignProspectingReservation.findUnique({ where: {
          workspaceId_recipientId: { workspaceId: current.workspaceId, recipientId: current.id } } }) : null;
        if (reservation) await lockProspectingConversation(tx, current.workspaceId, reservation.conversationId);
        if (current.verifiedAt || reservation?.dispatchIntentAt) return false;
        const changed = await tx.campaignRecipient.updateMany({
          where: { id: input.id, leaseToken: input.leaseToken, status: "in_flight", verifiedAt: null },
          data: { status: current.campaign.status === "canceled" ? "canceled" : "pending", leaseToken: null, leaseExpiresAt: null,
            ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
            errorMessage: input.reason ?? null }
        });
        if (changed.count && reservation) await tx.campaignProspectingReservation.deleteMany({ where: { id: reservation.id, dispatchIntentAt: null } });
        if (changed.count && input.pauseCampaign) {
          const recipient = await tx.campaignRecipient.findUniqueOrThrow({ where: { id: input.id } });
          await tx.campaign.updateMany({ where: { id: recipient.campaignId,
            workspaceId: recipient.workspaceId, status: { in: ["scheduled", "sending"] } },
          data: { status: "paused" } });
        }
        return changed.count === 1;
      });
    },

    async reserveProspecting(id: string, leaseToken: string) {
      try {
        return await prisma.$transaction(async tx => {
          const recipient = await tx.campaignRecipient.findFirst({ where: { id, leaseToken, status: 'in_flight' }, include: { campaign: true } });
          if (!recipient?.campaign.prospectingAgentId) return { status: 'ordinary' as const };
          if (!recipient.channelId || !recipient.phoneSnapshot) return { status: 'unavailable' as const };
          try { await validateProspectingAgent(tx, recipient.workspaceId, recipient.campaign.prospectingAgentId, recipient.channelId); }
          catch { return { status: 'unavailable' as const }; }
          // All campaigns targeting this identity serialize here, including rows imported without a contact id.
          const savedContact = recipient.contactId ? await tx.contact.findFirst({ where: { workspaceId: recipient.workspaceId, id: recipient.contactId } }) : null;
          const contact = savedContact ?? await tx.contact.upsert({ where: { workspaceId_phone: { workspaceId: recipient.workspaceId, phone: recipient.phoneSnapshot } },
            create: { workspaceId: recipient.workspaceId, phone: recipient.phoneSnapshot }, update: {} });
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${recipient.workspaceId}:${recipient.channelId}:${contact.id}`}, 0))`;
          const proposedConversation = await tx.conversation.upsert({ where: { workspaceId_channelId_contactId: {
            workspaceId: recipient.workspaceId, channelId: recipient.channelId, contactId: contact.id } },
            create: { workspaceId: recipient.workspaceId, channelId: recipient.channelId, contactId: contact.id, hiddenUntilReply: recipient.campaign.hideFromInboxUntilReply }, update: {} });
          await lockProspectingConversation(tx, recipient.workspaceId, proposedConversation.id);
          const conversation = await tx.conversation.findUniqueOrThrow({ where: { id: proposedConversation.id } });
          const existing = await tx.campaignProspectingReservation.findUnique({ where: { workspaceId_conversationId: { workspaceId: recipient.workspaceId, conversationId: conversation.id } } });
          const active = await tx.aiAgentSession.count({ where: { workspaceId: recipient.workspaceId, conversationId: conversation.id, status: 'active' } });
          if (conversation.aiControlStatus === 'human_controlled' || conversation.assignedUserId || conversation.activeAgentSessionId || active) return { status: 'in_service' as const };
          if (existing) return existing.status === 'prepared' && !existing.dispatchIntentAt && existing.recipientId === recipient.id &&
            existing.campaignId === recipient.campaignId && existing.agentId === recipient.campaign.prospectingAgentId
              ? { status: 'reserved' as const, generation: existing.generation } : { status: 'in_service' as const };
          const reservation = await tx.campaignProspectingReservation.create({ data: {
            workspaceId: recipient.workspaceId, channelId: recipient.channelId, contactId: contact.id, conversationId: conversation.id,
            campaignId: recipient.campaignId, recipientId: recipient.id, agentId: recipient.campaign.prospectingAgentId,
            dispatchStartedAt: now(), status: 'prepared' } });
          await tx.campaignRecipient.update({ where: { id }, data: { contactId: contact.id } });
          return { status: 'reserved' as const, generation: reservation.generation };
        });
      } catch (error) {
        if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') return { status: 'in_service' as const };
        throw error;
      }
    },

    async prospectingSendStillAllowed(id: string) {
      const recipient = await prisma.campaignRecipient.findUniqueOrThrow({ where: { id }, include: { campaign: true } });
      if (!recipient.campaign.prospectingAgentId) return true;
      try { await validateProspectingAgent(prisma, recipient.workspaceId, recipient.campaign.prospectingAgentId, recipient.channelId ?? undefined); }
      catch { return false; }
      const reservation = await prisma.campaignProspectingReservation.findUnique({ where: { workspaceId_recipientId: { workspaceId: recipient.workspaceId, recipientId: id } } });
      if (!reservation || !['prepared','sending'].includes(reservation.status)) return false;
      const conversation = await prisma.conversation.findFirst({ where: { id: reservation.conversationId, workspaceId: reservation.workspaceId } });
      return conversation?.aiControlStatus === 'agent_allowed' && !conversation.assignedUserId && !conversation.activeAgentSessionId;
    },

    /** Persist send intent at the last boundary before entering provider I/O. */
    async markVerified(id: string, leaseToken: string) {
      return prisma.$transaction(async tx => {
        const recipient = await tx.campaignRecipient.findFirst({ where: { id, leaseToken, status: "in_flight", verifiedAt: null,
          leaseExpiresAt: { gt: now() } }, include: { campaign: true } });
        if (!recipient || !["scheduled", "sending"].includes(recipient.campaign.status)) return false;
        const reservation = await tx.campaignProspectingReservation.findUnique({ where: { workspaceId_recipientId: {
          workspaceId: recipient.workspaceId, recipientId: recipient.id } } });
        if (recipient.campaign.prospectingAgentId) {
          if (!reservation) return false;
          await lockProspectingConversation(tx, recipient.workspaceId, reservation.conversationId);
          try { await validateProspectingAgent(tx, recipient.workspaceId, recipient.campaign.prospectingAgentId, recipient.channelId ?? undefined); }
          catch { return false; }
          const current = await tx.campaignProspectingReservation.findUniqueOrThrow({ where: { id: reservation.id } });
          const conversation = await tx.conversation.findUniqueOrThrow({ where: { id: current.conversationId } });
          if (current.status !== "prepared" || current.dispatchIntentAt || current.agentId !== recipient.campaign.prospectingAgentId ||
              conversation.aiControlStatus !== "agent_allowed" || conversation.assignedUserId || conversation.activeAgentSessionId) return false;
        }
        const intentAt = now();
        const changed = await tx.campaignRecipient.updateMany({ where: { id, leaseToken, status: "in_flight", verifiedAt: null,
          leaseExpiresAt: { gt: intentAt }, campaign: { status: { in: ["scheduled", "sending"] } } }, data: { verifiedAt: intentAt } });
        if (!changed.count) return false;
        if (reservation) await tx.campaignProspectingReservation.update({ where: { id: reservation.id }, data: {
          status: "sending", dispatchIntentAt: intentAt, pendingInboundMessageId: null, pendingInboundAt: null,
          latestInboundMessageId: null, latestInboundAt: null } });
        return true;
      });
    },

    async settle(input: {
      id: string; leaseToken: string; status: "sent" | "skipped_no_whatsapp" | "skipped_in_service" | "uncertain";
      providerMessageId?: string | null;
      sentAt?: Date;
      pauseSeconds?: number;
      nextAvailableAt?: Date;
      attemptsSincePause?: number;
      errorMessage?: string;
      contactId?: string;
      message?: string;
    }) {
      return prisma.$transaction(async (tx) => {
        if (tx.campaignProspectingReservation) {
          const identity = await tx.campaignRecipient.findUniqueOrThrow({ where: { id: input.id } });
          const origin = await tx.campaignProspectingReservation.findUnique({ where: { workspaceId_recipientId: {
            workspaceId: identity.workspaceId, recipientId: identity.id } } });
          if (origin) await lockProspectingConversation(tx, origin.workspaceId, origin.conversationId);
        }
        const changed = await tx.campaignRecipient.updateMany({
          where: { id: input.id, leaseToken: input.leaseToken, status: "in_flight" },
          data: { status: input.status, leaseToken: null, leaseExpiresAt: null,
            providerMessageId: input.providerMessageId ?? null,
            sentAt: input.sentAt ?? null, pauseSeconds: input.pauseSeconds ?? 0,
            errorMessage: input.errorMessage ?? null,
            attempts: input.status === "sent" || input.status === "uncertain" ? 1 : 0,
            result: { outcome: input.status, providerMessageId: input.providerMessageId ?? null } }
        });
        if (changed.count !== 1) return { settled: false, conversationId: null as string | null, replay: null as {workspaceId:string;conversationId:string;messageId:string}|null };
        const recipient = await tx.campaignRecipient.findUniqueOrThrow({ where: { id: input.id },
          include: { campaign: { select: { hideFromInboxUntilReply: true } } } });
        let conversationId: string | null = null;
        let replay: { workspaceId: string; conversationId: string; messageId: string } | null = null;
        if (input.nextAvailableAt && recipient.channelId) {
          await tx.campaignChannelThrottle.update({
            where: { workspaceId_channelId: { workspaceId: recipient.workspaceId,
              channelId: recipient.channelId } },
            data: { nextAvailableAt: input.nextAvailableAt,
              attemptsSincePause: input.attemptsSincePause ?? 0 }
          });
          await tx.campaignRecipient.updateMany({ where: { workspaceId: recipient.workspaceId,
            channelId: recipient.channelId, status: "pending",
            scheduledAt: { lt: input.nextAvailableAt } },
          data: { scheduledAt: input.nextAvailableAt } });
        }
        if (input.status === "sent" && recipient.channelId && input.message && recipient.phoneSnapshot) {
          const sentAt = input.sentAt ?? now();
          const snapshot = recipient.contactSnapshot && typeof recipient.contactSnapshot === "object" &&
            !Array.isArray(recipient.contactSnapshot) ? recipient.contactSnapshot : {};
          const persistedContactId = input.contactId ?? recipient.contactId;
          const contact = persistedContactId ? { id: persistedContactId } : await tx.contact.upsert({
            where: { workspaceId_phone: { workspaceId: recipient.workspaceId,
              phone: recipient.phoneSnapshot } },
            create: { workspaceId: recipient.workspaceId, phone: recipient.phoneSnapshot,
              name: typeof snapshot.name === "string" ? snapshot.name : null }, update: {}
          });
          const conversation = await tx.conversation.upsert({
            where: { workspaceId_channelId_contactId: { workspaceId: recipient.workspaceId,
              channelId: recipient.channelId, contactId: contact.id } },
            create: { workspaceId: recipient.workspaceId, channelId: recipient.channelId,
              contactId: contact.id, status: "open", unreadCount: 0,
              hiddenUntilReply: recipient.campaign.hideFromInboxUntilReply }, update: {}
          });
          conversationId = conversation.id;
          await tx.message.upsert({ where: input.providerMessageId
            ? { workspaceId_providerMessageId: { workspaceId: recipient.workspaceId,
                providerMessageId: input.providerMessageId } }
            : { workspaceId_providerEventId: { workspaceId: recipient.workspaceId,
                providerEventId: `campaign:${recipient.id}` } },
            create: { workspaceId: recipient.workspaceId, conversationId: conversation.id,
              providerEventId: `campaign:${recipient.id}`, providerMessageId: input.providerMessageId,
              direction: "outbound", type: "text", body: input.message,
              status: "sent", createdAt: sentAt }, update: {} });
          await tx.conversation.updateMany({ where: { id: conversation.id,
            workspaceId: recipient.workspaceId,
            AND: [{ OR: [{ lastMessageAt: null }, { lastMessageAt: { lte: sentAt } }] },
              { OR: [{ lastMessagePreviewAt: null }, { lastMessagePreviewAt: { lte: sentAt } }] }] },
          data: { ...(!recipient.campaign.hideFromInboxUntilReply ? { lastMessageAt: sentAt,
            hiddenUntilReply: false } : {}), lastMessagePreview: input.message,
            lastMessagePreviewAt: sentAt } });
        }
        if (tx.campaignProspectingReservation) {
          const reservation = await tx.campaignProspectingReservation.findUnique({ where: { workspaceId_recipientId: { workspaceId: recipient.workspaceId, recipientId: recipient.id } } });
          if (reservation && !reservation.dispatchIntentAt && ["skipped_no_whatsapp", "skipped_in_service"].includes(input.status)) {
            await tx.campaignProspectingReservation.deleteMany({ where: { id: reservation.id, dispatchIntentAt: null } });
          } else if (reservation) {
            // Confirmation and the outbound message live in this transaction; an inbound waiting
            // on this reservation is replayed only after this transaction has committed.
            const changed = await tx.campaignProspectingReservation.updateMany({ where: { id: reservation.id, generation: reservation.generation, status: 'sending' },
              data: { status: input.status === 'sent' ? 'confirmed' : 'uncertain', confirmedAt: input.status === 'sent' ? now() : null } });
            if (changed.count && input.status === 'sent') replay = await activateConfirmedProspecting(tx, reservation.id);
          }
        }
        if (input.status === "uncertain") {
          await tx.campaign.updateMany({ where: { id: recipient.campaignId,
            workspaceId: recipient.workspaceId }, data: { status: "needs_attention" } });
        } else {
          const remaining = await tx.campaignRecipient.count({ where: {
            workspaceId: recipient.workspaceId, campaignId: recipient.campaignId,
            status: { in: ["pending", "in_flight", "uncertain"] } } });
          if (remaining === 0) await tx.campaign.updateMany({ where: {
            id: recipient.campaignId, workspaceId: recipient.workspaceId,
            status: { in: ["scheduled", "sending", "paused"] } }, data: { status: "completed" } });
        }
        return { settled: true, conversationId, ...(replay ? { replay } : {}) };
      });
    },

    /** Messages of this campaign sent since an instant (the daily quota). */
    async sentSince(workspaceId: string, campaignId: string, since: Date) {
      return prisma.campaignRecipient.count({ where: { workspaceId, campaignId, status: "sent", sentAt: { gte: since } } });
    },

    async throttle(workspaceId: string, channelId: string) {
      return prisma.campaignChannelThrottle.findUniqueOrThrow({
        where: { workspaceId_channelId: { workspaceId, channelId } }
      });
    },

    async markExpiredUncertain() {
      return prisma.$transaction(async (tx) => {
        const expired = await tx.campaignRecipient.findMany({ where: {
          status: "in_flight", leaseExpiresAt: { lt: now() }
        }, select: { id: true, campaignId: true, workspaceId: true } });
        if (expired.length === 0) return 0;
        const origins = tx.campaignProspectingReservation ? await tx.campaignProspectingReservation.findMany({ where: {
          recipientId: { in: expired.map(row => row.id) } }, orderBy: [{ workspaceId: "asc" }, { conversationId: "asc" }] }) : [];
        await lockProspectingConversations(tx, origins);
        let changedCount = 0;
        for (const row of expired.sort((a,b) => a.id.localeCompare(b.id))) {
          const origin = origins.find(candidate => candidate.recipientId === row.id);
          if (origin && !origin.dispatchIntentAt && ["prepared", "stopped"].includes(origin.status)) {
            const recovered = await tx.campaignRecipient.updateMany({ where: { id: row.id, status: "in_flight", verifiedAt: null,
              leaseExpiresAt: { lt: now() } }, data: { status: "pending", leaseToken: null, leaseExpiresAt: null, errorMessage: null } });
            if (recovered.count) await tx.campaignProspectingReservation.deleteMany({ where: { id: origin.id, dispatchIntentAt: null } });
            continue;
          }
          const changed = await tx.campaignRecipient.updateMany({ where: { id: row.id,
            status: "in_flight", leaseExpiresAt: { lt: now() } },
          data: { status: "uncertain", leaseToken: null, leaseExpiresAt: null,
            errorMessage: "O resultado do envio não pôde ser confirmado." } });
          if (!changed.count) continue;
          changedCount += 1;
          await tx.campaignProspectingReservation?.updateMany({ where: { workspaceId: row.workspaceId, recipientId: row.id, status: "sending" }, data: { status: "uncertain" } });
          await tx.campaign.updateMany({ where: { id: row.campaignId,
            workspaceId: row.workspaceId }, data: { status: "needs_attention" } });
        }
        return changedCount;
      });
    }
  };
}
