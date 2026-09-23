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
          WHERE r.status = 'pending' AND r.scheduled_at <= ${now()}
            AND c.status IN ('scheduled', 'sending')
            AND (t.next_available_at IS NULL OR t.next_available_at <= ${now()})
            AND NOT EXISTS (
              SELECT 1 FROM campaign_recipients active
              WHERE active.workspace_id = r.workspace_id
                AND active.channel_id = r.channel_id AND active.status IN ('in_flight', 'uncertain')
            )
          ORDER BY r.scheduled_at, r.id
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
        const changed = await tx.campaignRecipient.updateMany({
          where: { id: input.id, leaseToken: input.leaseToken, status: "in_flight" },
          data: { status: "pending", leaseToken: null, leaseExpiresAt: null,
            ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
            errorMessage: input.reason ?? null }
        });
        if (changed.count && input.pauseCampaign) {
          const recipient = await tx.campaignRecipient.findUniqueOrThrow({ where: { id: input.id } });
          await tx.campaign.updateMany({ where: { id: recipient.campaignId,
            workspaceId: recipient.workspaceId, status: { in: ["scheduled", "sending"] } },
          data: { status: "paused" } });
        }
        return changed.count === 1;
      });
    },

    async markVerified(id: string, leaseToken: string) {
      const changed = await prisma.campaignRecipient.updateMany({ where: {
        id, leaseToken, status: "in_flight", leaseExpiresAt: { gt: now() }
      }, data: { verifiedAt: now() } });
      return changed.count === 1;
    },

    async settle(input: {
      id: string; leaseToken: string; status: "sent" | "skipped_no_whatsapp" | "uncertain";
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
        const changed = await tx.campaignRecipient.updateMany({
          where: { id: input.id, leaseToken: input.leaseToken, status: "in_flight" },
          data: { status: input.status, leaseToken: null, leaseExpiresAt: null,
            providerMessageId: input.providerMessageId ?? null,
            sentAt: input.sentAt ?? null, pauseSeconds: input.pauseSeconds ?? 0,
            errorMessage: input.errorMessage ?? null,
            attempts: input.status === "sent" || input.status === "uncertain" ? 1 : 0,
            result: { outcome: input.status, providerMessageId: input.providerMessageId ?? null } }
        });
        if (changed.count !== 1) return false;
        const recipient = await tx.campaignRecipient.findUniqueOrThrow({ where: { id: input.id } });
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
          const snapshot = recipient.contactSnapshot && typeof recipient.contactSnapshot === "object" &&
            !Array.isArray(recipient.contactSnapshot) ? recipient.contactSnapshot : {};
          const contact = input.contactId ? { id: input.contactId } : await tx.contact.upsert({
            where: { workspaceId_phone: { workspaceId: recipient.workspaceId,
              phone: recipient.phoneSnapshot } },
            create: { workspaceId: recipient.workspaceId, phone: recipient.phoneSnapshot,
              name: typeof snapshot.name === "string" ? snapshot.name : null }, update: {}
          });
          const conversation = await tx.conversation.upsert({
            where: { workspaceId_channelId_contactId: { workspaceId: recipient.workspaceId,
              channelId: recipient.channelId, contactId: contact.id } },
            create: { workspaceId: recipient.workspaceId, channelId: recipient.channelId,
              contactId: contact.id, status: "open", unreadCount: 0 }, update: {}
          });
          await tx.message.upsert({ where: { workspaceId_providerEventId: {
            workspaceId: recipient.workspaceId, providerEventId: `campaign:${recipient.id}` } },
            create: { workspaceId: recipient.workspaceId, conversationId: conversation.id,
              providerEventId: `campaign:${recipient.id}`, providerMessageId: input.providerMessageId,
              direction: "outbound", type: "text", body: input.message,
              status: "sent", createdAt: input.sentAt ?? now() }, update: {} });
          await tx.conversation.updateMany({ where: { id: conversation.id,
            workspaceId: recipient.workspaceId },
          data: { lastMessageAt: input.sentAt ?? now(), lastMessagePreview: input.message } });
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
        return true;
      });
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
        let changedCount = 0;
        for (const row of expired) {
          const changed = await tx.campaignRecipient.updateMany({ where: { id: row.id,
            status: "in_flight", leaseExpiresAt: { lt: now() } },
          data: { status: "uncertain", leaseToken: null, leaseExpiresAt: null,
            errorMessage: "O resultado do envio não pôde ser confirmado." } });
          if (!changed.count) continue;
          changedCount += 1;
          await tx.campaign.updateMany({ where: { id: row.campaignId,
            workspaceId: row.workspaceId }, data: { status: "needs_attention" } });
        }
        return changedCount;
      });
    }
  };
}
