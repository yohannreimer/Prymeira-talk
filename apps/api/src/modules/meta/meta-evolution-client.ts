import type { PrismaClient } from '@prisma/client';
import type { EvolutionClient } from '../evolution/evolution.client.js';
import { evolutionWebhookProvesOwnership } from '../evolution/evolution-webhook-ownership.js';
import { createOutboundDispatchJournal, type DispatchKind } from '../channels/outbound-dispatch-journal.js';
import { OutboundUncertainError } from '../channels/outbound-router.js';
import { classifySendFailure } from '../channels/outbound-routing.js';

export type MetaEvolutionDb = Pick<PrismaClient, 'channel' | 'channelConnection' | 'outboundDispatch' | '$executeRaw'>;
export type ExpectedEvolutionWebhook = { webhookUrl: string; webhookSecret: string };
const ownershipError = () => Object.assign(new Error('The Evolution session does not have a verified unique owner in this workspace.'), { code: 'CHANNEL_PROVIDER_OWNERSHIP_UNVERIFIED', statusCode: 409 });

/** Only returns an attestation, never remote configuration or provider credentials. */
export function createMetaEvolutionAttestation(base: EvolutionClient, instanceName: string | null, expected?: ExpectedEvolutionWebhook) {
  return async (requested: string): Promise<boolean> => {
    if (!instanceName || requested !== instanceName || !expected || !base.getWebhook) return false;
    return evolutionWebhookProvesOwnership(await base.getWebhook({ instanceName: requested }), expected);
  };
}

/** Meta's per-workspace Evolution client shares the physical namespace with QR channels.
 * Guard every method centrally, including callers outside the main outbound router. */
export function createOwnedMetaEvolutionClient(base: EvolutionClient, db: Partial<MetaEvolutionDb>, workspaceId: string,
  instanceName: string | null, expected?: ExpectedEvolutionWebhook): EvolutionClient {
  const attest = createMetaEvolutionAttestation(base, instanceName, expected);
  async function owner(input: { instanceName: string; workspaceId?: string; channelId?: string }) {
    if (!instanceName || input.instanceName !== instanceName || (input.workspaceId !== undefined && input.workspaceId !== workspaceId)
      || !db.channel || !db.channelConnection) throw ownershipError();
    const rows = await db.channel.findMany({ where: { providerKey: input.instanceName }, take: 2 });
    const channel = rows[0];
    if (rows.length !== 1 || !channel || channel.workspaceId !== workspaceId || channel.provider !== 'meta_cloud' || channel.archivedAt
      || (input.channelId !== undefined && input.channelId !== channel.id)) throw ownershipError();
    const physical = await db.channelConnection.findMany({ where: { provider: 'evolution', sessionName: input.instanceName } });
    if (physical.length > 1 || physical.some(row => row.workspaceId !== workspaceId || row.channelId !== channel.id)) throw ownershipError();
    if (channel.providerInstanceClaim !== input.instanceName) {
      if (channel.providerInstanceClaim || !await attest(input.instanceName)) throw ownershipError();
      const changed = await db.channel.updateMany({ where: { workspaceId, id: channel.id, providerKey: input.instanceName,
        archivedAt: null, providerInstanceClaim: null }, data: { providerInstanceClaim: input.instanceName } });
      if (changed.count !== 1) throw ownershipError();
    }
    return channel;
  }
  const kinds: Partial<Record<keyof EvolutionClient, DispatchKind>> = {
    sendText: 'text', sendTemplate: 'template', sendMedia: 'media', sendAudio: 'audio', sendContact: 'contact', editMessage: 'edit', deleteMessageForEveryone: 'delete'
  };
  return new Proxy(base, {
    get(target, key, receiver) {
      const method = Reflect.get(target, key, receiver);
      if (typeof method !== 'function') return method;
      return async (input: { instanceName: string; workspaceId?: string; channelId?: string; number?: string; remoteJid?: string; text?: string; caption?: string }) => {
        const channel = await owner(input);
        const kind = kinds[key as keyof EvolutionClient];
        if (!kind) {
          if (key === 'setWebhook' && (!expected || !evolutionWebhookProvesOwnership({ enabled: true, url: (input as unknown as { webhookUrl: string }).webhookUrl,
            headers: { 'x-prymeira-talk-secret': (input as unknown as { webhookSecret: string }).webhookSecret } }, expected))) throw ownershipError();
          return method.call(target, input);
        }
        if (!db.outboundDispatch || !db.$executeRaw) throw Object.assign(new Error('Durable dispatch storage is unavailable.'), { code: 'OUTBOUND_JOURNAL_UNAVAILABLE', statusCode: 503 });
        const journal = createOutboundDispatchJournal(db as MetaEvolutionDb);
        const dispatchId = await journal.begin({ workspaceId, channelId: channel.id, kind, destination: input.number ?? input.remoteJid ?? '', text: input.text ?? input.caption ?? null });
        const uncertain = async (error: unknown): Promise<never> => {
          try { await journal.markUncertain(dispatchId, code(error)); } catch { /* persisted sending intention is swept to uncertain */ }
          throw new OutboundUncertainError(dispatchId, error);
        };
        let sent: { providerMessageId?: string | null } | undefined;
        try { sent = await method.call(target, input); }
        catch (error) {
          const outcome = classifySendFailure(error, 'evolution');
          try { await journal.recordAttempt(dispatchId, { connectionId: null, provider: 'evolution', outcome, code: code(error) }); }
          catch (journalError) { return uncertain(journalError); }
          if (outcome === 'uncertain') return uncertain(error);
          await journal.fail(dispatchId, code(error));
          throw error;
        }
        try {
          await journal.recordAttempt(dispatchId, { connectionId: null, provider: 'evolution', outcome: 'accepted', code: null });
          await journal.accept(dispatchId, { connectionId: null, providerMessageId: sent?.providerMessageId ?? null });
        } catch (error) { return uncertain(error); }
        return sent;
      };
    }
  });
}

function code(error: unknown) {
  const record = error as { code?: unknown; statusCode?: unknown } | null;
  return typeof record?.code === 'string' ? record.code.slice(0, 60) : typeof record?.statusCode === 'number' ? `HTTP_${record.statusCode}` : 'PROVIDER_ERROR';
}
