import type { PrismaClient } from "@prisma/client";
import { DEFAULT_CAMPAIGN_CADENCE, nextCampaignInstant, type CampaignCadence } from "./campaign-cadence.js";

export class CampaignControlError extends Error {
  constructor(public code: "CAMPAIGN_NOT_FOUND" | "CAMPAIGN_CONTROL_INVALID", message: string) {
    super(message);
  }
}

export function createCampaignControlsService(prisma: PrismaClient, options: {
  now?: () => Date;
} = {}) {
  const now = options.now ?? (() => new Date());
  const load = async (workspaceId: string, campaignId: string) => {
    const campaign = await prisma.campaign.findFirst({ where: { workspaceId, id: campaignId } });
    if (!campaign) throw new CampaignControlError("CAMPAIGN_NOT_FOUND", "Campanha não encontrada.");
    return campaign;
  };
  return {
    async progress(workspaceId: string, campaignId: string) {
      const campaign = await load(workspaceId, campaignId);
      const rows = await prisma.campaignRecipient.findMany({ where: { workspaceId, campaignId },
        select: { status: true, scheduledAt: true } });
      const count = (...statuses: string[]) => rows.filter((row) => statuses.includes(row.status)).length;
      const next = rows.filter((row) => row.status === "pending" && row.scheduledAt)
        .map((row) => row.scheduledAt!).sort((a, b) => a.getTime() - b.getTime())[0];
      return { status: campaign.status, total: rows.length, sent: count("sent"),
        pending: count("pending", "in_flight"), skipped: count("skipped_no_whatsapp"),
        failed: count("failed"), uncertain: count("uncertain"),
        nextScheduledAt: next?.toISOString() ?? null };
    },

    async resolveUncertain(input: { workspaceId: string; campaignId: string;
      recipientId: string; actorId: string; outcome: "sent" | "not_sent" }) {
      await load(input.workspaceId, input.campaignId);
      await prisma.$transaction(async (tx) => {
        const changed = await tx.campaignRecipient.updateMany({ where: {
          id: input.recipientId, workspaceId: input.workspaceId,
          campaignId: input.campaignId, status: "uncertain"
        }, data: { status: input.outcome === "sent" ? "sent" : "failed",
          errorMessage: input.outcome === "sent" ? null : "Operador confirmou que não foi enviado.",
          result: { outcome: input.outcome, manualReview: true,
            reviewedBy: input.actorId, reviewedAt: now().toISOString() } } });
        if (!changed.count) throw new CampaignControlError("CAMPAIGN_CONTROL_INVALID",
          "Este envio já foi revisado ou não pertence à campanha.");
        const uncertain = await tx.campaignRecipient.count({ where: {
          workspaceId: input.workspaceId, campaignId: input.campaignId, status: "uncertain" } });
        if (uncertain === 0) {
          const remaining = await tx.campaignRecipient.count({ where: {
            workspaceId: input.workspaceId, campaignId: input.campaignId,
            status: { in: ["pending", "in_flight"] } } });
          await tx.campaign.updateMany({ where: { workspaceId: input.workspaceId,
            id: input.campaignId, status: "needs_attention" },
          data: { status: remaining > 0 ? "paused" : "completed" } });
        }
      });
      return this.progress(input.workspaceId, input.campaignId);
    },

    async pause(workspaceId: string, campaignId: string) {
      await load(workspaceId, campaignId);
      const changed = await prisma.campaign.updateMany({ where: { workspaceId, id: campaignId,
        status: { in: ["scheduled", "sending"] } }, data: { status: "paused" } });
      if (!changed.count) throw new CampaignControlError("CAMPAIGN_CONTROL_INVALID",
        "Só uma fila ativa pode ser pausada.");
      return this.progress(workspaceId, campaignId);
    },

    async resume(workspaceId: string, campaignId: string) {
      const campaign = await load(workspaceId, campaignId);
      if (campaign.status !== "paused") throw new CampaignControlError("CAMPAIGN_CONTROL_INVALID",
        "Só uma fila pausada pode ser retomada.");
      const cadence = { ...DEFAULT_CAMPAIGN_CADENCE,
        ...(campaign.cadence as Partial<CampaignCadence>) };
      await prisma.$transaction(async (tx) => {
        const pending = await tx.campaignRecipient.findMany({ where: { workspaceId, campaignId,
          status: "pending" }, orderBy: [{ sequenceNumber: "asc" }, { createdAt: "asc" }] });
        if (pending.length === 0) throw new CampaignControlError("CAMPAIGN_CONTROL_INVALID",
          "Não há mensagens pendentes para retomar.");
        const throttle = campaign.channelId ? await tx.campaignChannelThrottle.findUnique({
          where: { workspaceId_channelId: { workspaceId, channelId: campaign.channelId } }
        }) : null;
        const base = throttle?.nextAvailableAt && throttle.nextAvailableAt > now()
          ? throttle.nextAvailableAt : now();
        let scheduledAt = nextCampaignInstant(base, 0, campaign.timeZone, cadence);
        let firstScheduledAt: Date | null = null;
        for (const [index, row] of pending.entries()) {
          if (index > 0) scheduledAt = nextCampaignInstant(scheduledAt,
            pending[index - 1]!.gapSeconds ?? cadence.minDelaySeconds,
            campaign.timeZone, cadence);
          const forward = row.scheduledAt && row.scheduledAt > scheduledAt
            ? row.scheduledAt : scheduledAt;
          scheduledAt = forward;
          if (index === 0) firstScheduledAt = forward;
          await tx.campaignRecipient.update({ where: { id: row.id }, data: { scheduledAt: forward } });
        }
        const status = firstScheduledAt && firstScheduledAt > now()
          ? "scheduled" : "sending";
        const changed = await tx.campaign.updateMany({ where: { workspaceId, id: campaignId,
          status: "paused" }, data: { status } });
        if (!changed.count) throw new CampaignControlError("CAMPAIGN_CONTROL_INVALID",
          "O estado da campanha mudou. Atualize a página.");
      });
      return this.progress(workspaceId, campaignId);
    },

    async cancelRemaining(workspaceId: string, campaignId: string) {
      await load(workspaceId, campaignId);
      await prisma.$transaction(async (tx) => {
        const changed = await tx.campaign.updateMany({ where: { workspaceId, id: campaignId,
          status: { in: ["scheduled", "sending", "paused", "needs_attention"] } },
        data: { status: "canceled" } });
        if (!changed.count) throw new CampaignControlError("CAMPAIGN_CONTROL_INVALID",
          "Não há envios restantes para cancelar.");
        await tx.campaignRecipient.updateMany({ where: { workspaceId, campaignId,
          status: "pending" }, data: { status: "canceled" } });
      });
      return this.progress(workspaceId, campaignId);
    }
  };
}
