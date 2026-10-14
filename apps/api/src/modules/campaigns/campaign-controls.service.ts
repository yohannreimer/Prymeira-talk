import type { PrismaClient } from "@prisma/client";
import { DEFAULT_CAMPAIGN_CADENCE, isDailyCadence, nextCampaignInstant, planDailySchedule, type CampaignCadence } from "./campaign-cadence.js";

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
  /**
   * Tracking: per day (sent, still planned, replied) and per company city. "Respondeu" = the customer wrote in that
   * conversation after our message. Optional: the counters above never depend on it.
   */
  async function breakdown(workspaceId: string, campaignId: string, timeZone: string) {
    if (typeof prisma.$queryRaw !== "function") return {};
    try {
      const rows = await prisma.$queryRaw<Array<{ day: string | null; city: string | null; status: string; replied: boolean }>>`
        WITH r AS (
          SELECT r.status, r.sent_at, r.scheduled_at, r.channel_id, r.contact_snapshot,
            coalesce(r.contact_id, (SELECT ct.id FROM contacts ct WHERE ct.workspace_id = r.workspace_id AND ct.phone = r.phone_snapshot LIMIT 1)) AS contact_id
          FROM campaign_recipients r WHERE r.workspace_id = ${workspaceId} AND r.campaign_id = ${campaignId}::uuid
        )
        SELECT to_char(coalesce(r.sent_at, r.scheduled_at) AT TIME ZONE 'UTC' AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS day,
          nullif(trim(coalesce(
            (SELECT l.city FROM lead_contact_provenances p JOIN leads l ON l.id = p.lead_id AND l.workspace_id = p.workspace_id
              WHERE p.workspace_id = ${workspaceId} AND p.contact_id = r.contact_id AND nullif(trim(l.city), '') IS NOT NULL
              ORDER BY p.imported_at DESC LIMIT 1),
            r.contact_snapshot->'fields'->>'cidade', r.contact_snapshot->'fields'->>'Cidade', r.contact_snapshot->'fields'->>'city')), '') AS city,
          r.status,
          (r.status = 'sent' AND EXISTS (
            SELECT 1 FROM conversations c JOIN messages m ON m.workspace_id = c.workspace_id AND m.conversation_id = c.id
            WHERE c.workspace_id = ${workspaceId} AND c.channel_id = r.channel_id AND c.contact_id = r.contact_id
              AND m.direction = 'inbound' AND m.created_at > r.sent_at)) AS replied
        FROM r`;
      const days = new Map<string, { day: string; sent: number; planned: number; replied: number }>();
      const cities = new Map<string, { city: string; total: number; sent: number; replied: number }>();
      for (const row of rows) {
        const sent = row.status === "sent";
        const planned = row.status === "pending" || row.status === "in_flight";
        if (row.day && (sent || planned)) {
          const day = days.get(row.day) ?? { day: row.day, sent: 0, planned: 0, replied: 0 };
          day.sent += sent ? 1 : 0; day.planned += planned ? 1 : 0; day.replied += row.replied ? 1 : 0;
          days.set(row.day, day);
        }
        const name = row.city ?? "Sem cidade";
        const city = cities.get(name.toLocaleLowerCase("pt-BR")) ?? { city: name, total: 0, sent: 0, replied: 0 };
        city.total += 1; city.sent += sent ? 1 : 0; city.replied += row.replied ? 1 : 0;
        cities.set(name.toLocaleLowerCase("pt-BR"), city);
      }
      return { days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
        cities: [...cities.values()].sort((a, b) => b.total - a.total || a.city.localeCompare(b.city, "pt-BR")) };
    } catch { return {}; }
  }

  return {
    async progress(workspaceId: string, campaignId: string) {
      const campaign = await load(workspaceId, campaignId);
      const rows = await prisma.campaignRecipient.findMany({ where: { workspaceId, campaignId },
        select: { status: true, scheduledAt: true } });
      const count = (...statuses: string[]) => rows.filter((row) => statuses.includes(row.status)).length;
      const next = rows.filter((row) => row.status === "pending" && row.scheduledAt)
        .map((row) => row.scheduledAt!).sort((a, b) => a.getTime() - b.getTime())[0];
      return { status: campaign.status, total: rows.length, sent: count("sent"),
        pending: count("pending", "in_flight"), skipped: count("skipped_no_whatsapp", "skipped_in_service"), skippedInService: count("skipped_in_service"),
        failed: count("failed"), uncertain: count("uncertain"),
        nextScheduledAt: next?.toISOString() ?? null,
        ...await breakdown(workspaceId, campaignId, campaign.timeZone) };
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
        // Spread over days: what is left is planned again day by day from now, with new daily quotas.
        const daily = isDailyCadence(cadence) ? planDailySchedule({ start: scheduledAt, count: pending.length,
          timeZone: campaign.timeZone, cadence }) : null;
        for (const [index, row] of pending.entries()) {
          if (daily) {
            const planned = daily[index]!;
            await tx.campaignRecipient.update({ where: { id: row.id }, data: { scheduledAt: planned.scheduledAt, gapSeconds: planned.gapSeconds } });
            if (index === 0) firstScheduledAt = planned.scheduledAt;
            continue;
          }
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
