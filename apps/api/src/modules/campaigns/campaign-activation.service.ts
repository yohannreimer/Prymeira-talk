import type { PrismaClient } from "@prisma/client";
import type { AudiencePreview } from "./campaign-audience-preview.js";
import { DEFAULT_CAMPAIGN_CADENCE, drawGap, nextCampaignInstant, type CampaignCadence } from "./campaign-cadence.js";

export class CampaignActivationError extends Error {
  constructor(public code: "CAMPAIGN_NOT_FOUND" | "CAMPAIGN_NOT_DRAFT" |
    "CAMPAIGN_PREVIEW_CHANGED" | "CAMPAIGN_NO_ELIGIBLE_RECIPIENTS" |
    "CAMPAIGN_SCHEDULE_INVALID" | "CAMPAIGN_CADENCE_INVALID", message: string) {
    super(message);
  }
}

export type ActivateCampaignInput = {
  workspaceId: string;
  campaignId: string;
  actorId: string;
  idempotencyKey: string;
  channelId: string;
  startMode: "now" | "scheduled";
  scheduledAt: string | null;
  timeZone: string;
  confirmation: true;
  expectedAudienceHash: string;
  preview: AudiencePreview;
};

function cadenceFrom(value: unknown): CampaignCadence {
  if (!value || typeof value !== "object") throw new CampaignActivationError(
    "CAMPAIGN_CADENCE_INVALID", "Escolha um ritmo de envio antes de continuar.");
  const candidate = value as Partial<CampaignCadence>;
  const cadence = { ...DEFAULT_CAMPAIGN_CADENCE, ...candidate };
  if (!candidate.windowStart || !candidate.windowEnd ||
      !Number.isInteger(cadence.minDelaySeconds) || cadence.minDelaySeconds < 30 ||
      !Number.isInteger(cadence.maxDelaySeconds) || cadence.maxDelaySeconds > 3600 ||
      cadence.maxDelaySeconds < cadence.minDelaySeconds ||
      !Number.isInteger(cadence.batchSize) || cadence.batchSize < 1 || cadence.batchSize > 100 ||
      !Number.isInteger(cadence.pauseMinSeconds) || cadence.pauseMinSeconds < 0 ||
      !Number.isInteger(cadence.pauseMaxSeconds) || cadence.pauseMaxSeconds > 3600 ||
      cadence.pauseMaxSeconds < cadence.pauseMinSeconds ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(cadence.windowStart) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(cadence.windowEnd) ||
      cadence.windowStart >= cadence.windowEnd) {
    throw new CampaignActivationError("CAMPAIGN_CADENCE_INVALID",
      "Revise o ritmo: intervalo de 30 a 3600 segundos, pausa de até 3600 segundos e janela diária válida.");
  }
  return cadence;
}

export function createCampaignActivationService(prisma: PrismaClient, options: {
  now?: () => Date;
  draw?: (min: number, max: number) => number;
} = {}) {
  const now = options.now ?? (() => new Date());
  return {
    async activate(input: ActivateCampaignInput) {
      const prior = await prisma.campaign.findFirst({ where: {
        workspaceId: input.workspaceId, id: input.campaignId
      } });
      if (!prior) throw new CampaignActivationError("CAMPAIGN_NOT_FOUND", "Campanha não encontrada.");
      if (prior.activationKey === input.idempotencyKey) return prior;
      if (prior.status !== "draft") throw new CampaignActivationError("CAMPAIGN_NOT_DRAFT",
        "Esta campanha já foi ativada.");
      if (input.preview.audienceHash !== input.expectedAudienceHash) {
        throw new CampaignActivationError("CAMPAIGN_PREVIEW_CHANGED",
          "Os destinatários ou a mensagem mudaram. Verifique novamente.");
      }
      if (input.preview.eligible.length === 0 || input.preview.excluded.some((item) =>
        item.reason === "verification_error") || input.preview.unresolvedVariables.length > 0) {
        throw new CampaignActivationError("CAMPAIGN_NO_ELIGIBLE_RECIPIENTS",
          "Há destinatários sem verificação ou variáveis da mensagem sem valor.");
      }
      const cadence = cadenceFrom(prior.cadence);
      let start: Date;
      try {
        start = input.startMode === "scheduled" ? new Date(input.scheduledAt ?? "") : now();
        if (!Number.isFinite(start.getTime()) ||
          (input.startMode === "scheduled" && start <= now())) throw new RangeError();
        start = nextCampaignInstant(start, 0, input.timeZone, cadence);
      } catch {
        throw new CampaignActivationError("CAMPAIGN_SCHEDULE_INVALID",
          "Escolha uma data futura e um fuso horário válido.");
      }
      const activeStatus = start > now() ? "scheduled" : "sending";
      try {
        return await prisma.$transaction(async (tx) => {
          const changed = await tx.campaign.updateMany({
            where: { id: input.campaignId, workspaceId: input.workspaceId, status: "draft",
              updatedAt: new Date(input.preview.revision), activationKey: null },
            data: { status: activeStatus, activationKey: input.idempotencyKey,
              confirmedBy: input.actorId, confirmedAt: now(), channelId: input.channelId,
              startMode: input.startMode, scheduledAt: start, timeZone: input.timeZone, mode: "real" }
          });
          if (changed.count !== 1) throw new CampaignActivationError(
            "CAMPAIGN_PREVIEW_CHANGED", "A campanha mudou. Verifique os destinatários novamente.");
          const throttle = await tx.campaignChannelThrottle.upsert({
            where: { workspaceId_channelId: { workspaceId: input.workspaceId,
              channelId: input.channelId } },
            create: { workspaceId: input.workspaceId, channelId: input.channelId }, update: {}
          });
          const effectiveStart = throttle.nextAvailableAt && throttle.nextAvailableAt > start
            ? nextCampaignInstant(throttle.nextAvailableAt, 0, input.timeZone, cadence) : start;
          if (effectiveStart.getTime() !== start.getTime()) {
            await tx.campaign.update({ where: { id: input.campaignId },
              data: { scheduledAt: effectiveStart, status: effectiveStart > now()
                ? "scheduled" : "sending" } });
          }
          let scheduledAt = effectiveStart;
          const recipients = input.preview.eligible.map((contact, index) => {
            const gapSeconds = drawGap(cadence, options.draw);
            const row = { workspaceId: input.workspaceId, campaignId: input.campaignId,
              contactId: contact.contactId, audienceKey: contact.normalizedPhone,
              phoneSnapshot: contact.normalizedPhone, channelId: input.channelId,
              sequenceNumber: index + 1, gapSeconds, pauseSeconds: 0,
              status: "pending", scheduledAt,
              contactSnapshot: { name: contact.name, phone: contact.phone,
                fields: contact.fields, message: contact.message }, result: {} };
            if (gapSeconds > 0) scheduledAt = nextCampaignInstant(scheduledAt, gapSeconds,
              input.timeZone, cadence);
            return row;
          });
          await tx.campaignRecipient.createMany({ data: recipients });
          return tx.campaign.findUniqueOrThrow({ where: { workspaceId_id: {
            workspaceId: input.workspaceId, id: input.campaignId } } });
        });
      } catch (error) {
        if (error instanceof CampaignActivationError) throw error;
        const activated = await prisma.campaign.findFirst({ where: {
          workspaceId: input.workspaceId, id: input.campaignId,
          activationKey: input.idempotencyKey } });
        if (activated) return activated;
        throw error;
      }
    }
  };
}
