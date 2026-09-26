import type { PrismaClient } from '@prisma/client';
import { whatsappPhoneCandidates } from '../leads/lead-whatsapp-numbers.js';

type RecipientInput = { contactId?: string; phone?: string; name?: string };

export class InboxQuickSendError extends Error {
  constructor(public readonly code: 'CHANNEL_UNAVAILABLE' | 'RECIPIENT_INVALID' | 'CONTACT_NOT_FOUND', message: string) {
    super(message);
  }
}

/** Persists a reviewed inbox send in the existing campaign worker queue. */
export function createInboxQuickSendService(prisma: PrismaClient, now: () => Date = () => new Date()) {
  return {
    async enqueue(input: {
      workspaceId: string;
      actorId: string;
      idempotencyKey: string;
      channelId: string;
      body: string;
      recipients: RecipientInput[];
    }) {
      const prior = await prisma.campaign.findFirst({ where: {
        workspaceId: input.workspaceId, activationKey: input.idempotencyKey, startMode: 'inbox_quick'
      }, select: { id: true } });
      if (prior) return { campaignId: prior.id, recipientsQueued: await prisma.campaignRecipient.count({ where: {
        workspaceId: input.workspaceId, campaignId: prior.id
      } }) };

      const channel = await prisma.channel.findFirst({ where: {
        workspaceId: input.workspaceId, id: input.channelId, provider: 'evolution',
        status: { in: ['connected', 'connecting'] }
      }, select: { id: true } });
      if (!channel) throw new InboxQuickSendError('CHANNEL_UNAVAILABLE', 'Este canal WhatsApp não está disponível para envio.');

      const ids = input.recipients.flatMap((recipient) => recipient.contactId ? [recipient.contactId] : []);
      const contacts = ids.length ? await prisma.contact.findMany({ where: {
        workspaceId: input.workspaceId, id: { in: ids }
      }, select: { id: true, name: true, phone: true } }) : [];
      const byId = new Map(contacts.map((contact) => [contact.id, contact]));
      const unique = new Map<string, { contactId: string | null; phone: string; name: string | null }>();
      for (const recipient of input.recipients) {
        const contact = recipient.contactId ? byId.get(recipient.contactId) : null;
        if (recipient.contactId && !contact) throw new InboxQuickSendError('CONTACT_NOT_FOUND', 'Um contato selecionado não foi encontrado.');
        const candidate = whatsappPhoneCandidates(contact?.phone ?? recipient.phone ?? '');
        if (!candidate) throw new InboxQuickSendError('RECIPIENT_INVALID', 'Revise os números dos destinatários.');
        unique.set(candidate.key, { contactId: contact?.id ?? null, phone: candidate.key,
          name: contact?.name?.trim() || recipient.name?.trim() || null });
      }
      if (unique.size === 0) throw new InboxQuickSendError('RECIPIENT_INVALID', 'Selecione ao menos um destinatário.');
      const recipients = [...unique.values()];
      const start = now();
      try {
        return await prisma.$transaction(async (tx) => {
          const campaign = await tx.campaign.create({ data: {
            workspaceId: input.workspaceId, name: `Envio rápido ${start.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`,
            status: 'sending', audience: { type: 'imported', rows: recipients.map((recipient) => ({
              phone: recipient.phone, name: recipient.name ?? undefined
            })) }, messageBody: input.body, templates: [input.body], fallbackName: 'cliente',
            cadence: { minDelaySeconds: 0, maxDelaySeconds: 0, batchSize: 10,
              pauseMinSeconds: 180, pauseMaxSeconds: 180, windowStart: '00:00', windowEnd: '23:59' },
            scheduledAt: start, activationKey: input.idempotencyKey, confirmedBy: input.actorId,
            confirmedAt: start, channelId: input.channelId, startMode: 'inbox_quick',
            timeZone: 'America/Sao_Paulo', mode: 'real'
          } });
          await tx.campaignChannelThrottle.upsert({ where: { workspaceId_channelId: {
            workspaceId: input.workspaceId, channelId: input.channelId
          } }, create: { workspaceId: input.workspaceId, channelId: input.channelId }, update: {} });
          await tx.campaignRecipient.createMany({ data: recipients.map((recipient, index) => ({
            workspaceId: input.workspaceId, campaignId: campaign.id, contactId: recipient.contactId,
            audienceKey: recipient.phone, phoneSnapshot: recipient.phone, channelId: input.channelId,
            sequenceNumber: index + 1, gapSeconds: 0, pauseSeconds: 0,
            status: 'pending', scheduledAt: start,
            contactSnapshot: { name: recipient.name, phone: recipient.phone, message: input.body }, result: {}
          })) });
          return { campaignId: campaign.id, recipientsQueued: recipients.length };
        });
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
          const existing = await prisma.campaign.findFirst({ where: {
            workspaceId: input.workspaceId, activationKey: input.idempotencyKey, startMode: 'inbox_quick'
          }, select: { id: true } });
          if (existing) return { campaignId: existing.id, recipientsQueued: await prisma.campaignRecipient.count({ where: {
            workspaceId: input.workspaceId, campaignId: existing.id
          } }) };
        }
        throw error;
      }
    }
  };
}
