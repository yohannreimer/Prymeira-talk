import type { PrismaClient } from "@prisma/client";
import type { EvolutionClient } from "../evolution/evolution.client.js";
import { whatsappPhoneCandidates } from "../leads/lead-whatsapp-numbers.js";
import { DEFAULT_CAMPAIGN_CADENCE, drawPause, isDailyCadence, localDayStart, nextCampaignInstant, nextDayStart,
  type CampaignCadence, type Draw } from "./campaign-cadence.js";
import { createCampaignWorkerRepository } from "./campaign-worker.repository.js";

function cadenceFrom(value: unknown): CampaignCadence {
  const object = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<CampaignCadence> : {};
  return { ...DEFAULT_CAMPAIGN_CADENCE, ...object };
}

export function createCampaignWorker(input: {
  prisma: PrismaClient;
  evolution: Pick<EvolutionClient, "sendText" | "checkWhatsappNumbersAvailability">;
  pollMs?: number;
  now?: () => Date;
  draw?: Draw;
  onError?: (error: unknown) => void;
  onProspectingReplyReady?: (input: { workspaceId: string; conversationId: string; messageId: string }) => Promise<unknown>;
  onConversationUpdated?: (input: { workspaceId: string; conversationId: string }) => Promise<void>;
}) {
  const now = input.now ?? (() => new Date());
  const repository = createCampaignWorkerRepository(input.prisma, { now });
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let stopping = false;

  async function processOne(): Promise<boolean> {
    await repository.markExpiredUncertain();
    const job = await repository.claimDue();
    if (!job) return false;
    const token = job.leaseToken!;
    const cadence = cadenceFrom(job.campaign.cadence);
    const current = now();
    const legal = nextCampaignInstant(current, 0, job.campaign.timeZone, cadence);
    if (legal > current) {
      await repository.returnPending({ id: job.id, leaseToken: token, scheduledAt: legal });
      return true;
    }
    // Spread over days: never more than the daily maximum, even when yesterday's leftovers roll over.
    if (isDailyCadence(cadence)) {
      const sentToday = await repository.sentSince(job.workspaceId, job.campaignId, localDayStart(current, job.campaign.timeZone));
      if (sentToday >= cadence.dailyMax!) {
        await repository.returnPending({ id: job.id, leaseToken: token,
          scheduledAt: nextDayStart(current, job.campaign.timeZone, cadence) });
        return true;
      }
    }
    const snapshot = job.contactSnapshot && typeof job.contactSnapshot === "object" &&
      !Array.isArray(job.contactSnapshot) ? job.contactSnapshot : {};
    const message = typeof snapshot.message === "string" ? snapshot.message : "";
    const phone = job.phoneSnapshot;
    const candidate = phone ? whatsappPhoneCandidates(phone) : null;
    if (!candidate || !message || !job.channelId) {
      await repository.settle({ id: job.id, leaseToken: token, status: "uncertain",
        errorMessage: "Dados da fila incompletos; revisão humana necessária." });
      return true;
    }
    const channel = await input.prisma.channel.findFirst({ where: {
      id: job.channelId, workspaceId: job.workspaceId, provider: "evolution",
      status: job.campaign.startMode === 'inbox_quick' ? { in: ['connected', 'connecting'] } : 'connected'
    }, select: { providerKey: true } });
    if (!channel || !input.evolution.checkWhatsappNumbersAvailability) {
      await repository.returnPending({ id: job.id, leaseToken: token,
        pauseCampaign: true, reason: "Canal desconectado ou verificação indisponível." });
      return true;
    }
    let available: boolean;
    let sendNumber = candidate.primary;
    try {
      const checked = await input.evolution.checkWhatsappNumbersAvailability({
        instanceName: channel.providerKey, numbers: [candidate.primary]
      });
      const match = checked.numbers.find((item) =>
        whatsappPhoneCandidates(item.phone)?.key === candidate.key);
      if (!match) throw new Error("Evolution did not return this phone.");
      available = match.available;
      if (!available && candidate.alternate) {
        const alternate = await input.evolution.checkWhatsappNumbersAvailability({
          instanceName: channel.providerKey, numbers: [candidate.alternate]
        });
        const alternateMatch = alternate.numbers.find((item) =>
          whatsappPhoneCandidates(item.phone)?.key === candidate.key);
        if (!alternateMatch) throw new Error("Evolution did not return the alternate phone.");
        available = alternateMatch.available;
        if (available) sendNumber = candidate.alternate;
      }
    } catch {
      await repository.returnPending({ id: job.id, leaseToken: token,
        pauseCampaign: true, reason: "Não foi possível verificar o WhatsApp agora." });
      return true;
    }
    if (!available) {
      await repository.settle({ id: job.id, leaseToken: token, status: "skipped_no_whatsapp" });
      return true;
    }
    const reservation = await repository.reserveProspecting(job.id, token);
    if (reservation.status === 'unavailable') {
      await repository.returnPending({ id: job.id, leaseToken: token, pauseCampaign: true, reason: 'Agente ou módulo de prospecção indisponível.' });
      return true;
    }
    if (reservation.status === 'in_service') {
      await repository.settle({ id: job.id, leaseToken: token, status: 'skipped_in_service', errorMessage: 'Contato já está em atendimento ou reservado por outra campanha.' });
      return true;
    }
    if (!await repository.prospectingSendStillAllowed(job.id)) {
      await repository.settle({ id: job.id, leaseToken: token, status: 'skipped_in_service', errorMessage: 'Controle ou agente mudou antes do envio.' });
      return true;
    }

    if (!await repository.markVerified(job.id, token)) {
      await repository.returnPending({ id: job.id, leaseToken: token, reason: "Envio pausado antes da confirmação de intenção." });
      return true;
    }

    // The in-flight lease was persisted before this call. An error here may mean Evolution sent
    // the text but the acknowledgment was lost; never retry this recipient automatically.
    let providerMessageId: string | null;
    try {
      const sent = await input.evolution.sendText({ instanceName: channel.providerKey,
        number: sendNumber, text: message });
      providerMessageId = sent.providerMessageId;
    } catch {
      await repository.settle({ id: job.id, leaseToken: token, status: "uncertain",
        errorMessage: "O resultado do envio é incerto. Confira no WhatsApp antes de decidir." });
      return true;
    }
    if (!providerMessageId) {
      await repository.settle({ id: job.id, leaseToken: token, status: "uncertain",
        errorMessage: "A Evolution não confirmou um identificador para o envio. Confira no WhatsApp." });
      return true;
    }
    const sentAt = now();
    const throttle = await repository.throttle(job.workspaceId, job.channelId);
    const afterAttempts = throttle.attemptsSincePause + 1;
    // A day's messages are already spaced across the window; the batch pause is for same-day sends.
    const pauseSeconds = isDailyCadence(cadence) ? 0 : drawPause(cadence, input.draw, afterAttempts);
    const nextAvailableAt = nextCampaignInstant(sentAt,
      (job.gapSeconds ?? cadence.minDelaySeconds) + pauseSeconds,
      job.campaign.timeZone, cadence);
    const settled = await repository.settle({ id: job.id, leaseToken: token, status: "sent",
      providerMessageId, sentAt, pauseSeconds, nextAvailableAt,
      attemptsSincePause: pauseSeconds ? 0 : afterAttempts,
      contactId: job.contactId ?? undefined, message });
    if (settled.replay) await input.onProspectingReplyReady?.(settled.replay);
    if (settled.conversationId) await input.onConversationUpdated?.({
      workspaceId: job.workspaceId, conversationId: settled.conversationId
    });
    return true;
  }

  async function tick() {
    if (running || stopping) return;
    running = true;
    try {
      await processOne();
    } catch (error) {
      input.onError?.(error);
    } finally {
      running = false;
      if (!stopping) timer = setTimeout(() => void tick(), input.pollMs ?? 5_000);
    }
  }

  return {
    processOne,
    start() { if (!timer && !stopping) timer = setTimeout(() => void tick(), 0); },
    async stop() {
      stopping = true;
      if (timer) clearTimeout(timer);
      timer = null;
      while (running) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
}
