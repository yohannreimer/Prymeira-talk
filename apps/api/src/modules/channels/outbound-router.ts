import type { PrismaClient } from '@prisma/client';
import { AgentMediaError, resolveAgentMedia } from '../agents/agent-media-resolver.js';
import type { EvolutionClient, SendContactInput, SendMediaInput, SendMediaResult, SendTextInput, SendTextResult, SendTemplateInput, EditMessageInput, DeleteMessageInput } from '../evolution/evolution.client.js';
import { parseWahaMessageKey } from '../messaging/whatsapp-identity.js';
import type { WahaClient } from '../waha/waha.client.js';
import { resolveWahaDestination, WahaDestinationError } from '../waha/waha-destination.js';
import type { DispatchKind, OutboundDispatchJournal } from './outbound-dispatch-journal.js';
import { classifySendFailure, writerCandidates, type RoutableChannel, type RoutableConnection } from './outbound-routing.js';
import { sendCanonicalCampaignText, sendCanonicalProspectingText } from '../campaigns/campaign-canonical-send.js';
import { sendCanonicalFollowupText, ContextualFollowupBlocked } from '../followups/contextual-followup-delivery.js';

/** The single outbound router. It wraps the Evolution client, which every sender (human, AI, automations,
 * follow-ups, campaigns, prospecting) already uses, so all of them go through one place without being changed:
 * one connection writes each send, the journal records it, a send that provably did not leave is retried on the
 * other connection, and a send whose outcome is uncertain is checked on both connections and otherwise left for
 * review. It never resends an uncertain send. */

/** Raised instead of the provider error when a send may or may not have reached the customer. Callers treat it
 * as a failed send (as before) but must not retry it automatically. */
export class OutboundUncertainError extends Error {
  readonly code = 'OUTBOUND_UNCERTAIN';
  constructor(readonly dispatchId: string, readonly causeError: unknown) {
    super('The send may have been delivered; it is held for review and was not retried.');
    this.name = 'OutboundUncertainError';
  }
}

export type ProbeResult = { found: boolean; providerMessageId: string | null } | 'unknown';
/** Looks in the connection's own recent chat history for the message we just tried to send. */
export type DeliveryProbe = (input: { connection: ConnectionRef; destination: string; kind: DispatchKind; text: string | null; since: Date; providerMessageId?: string }) => Promise<ProbeResult>;
export type ConnectionRef = RoutableConnection & { sessionName: string };

type Db = Pick<PrismaClient, 'channel' | 'channelConnection' | 'outboundDispatch' | '$executeRaw'>;
type CommandScope = { instanceName: string; workspaceId?: string; channelId?: string };
type Sent = { providerMessageId: string | null; raw: unknown };
type Command =
  | { kind: 'text'; destination: string; text: string; input: SendTextInput }
  | { kind: 'media'; destination: string; text: string | null; input: SendMediaInput }
  | { kind: 'audio'; destination: string; text: null; input: { instanceName: string; number: string; audio: string } }
  | { kind: 'contact'; destination: string; text: null; input: SendContactInput }
  | { kind: 'template'; destination: string; text: null; input: SendTemplateInput }
  | { kind: 'edit'; destination: string; text: string; input: EditMessageInput }
  | { kind: 'delete'; destination: string; text: null; input: DeleteMessageInput };

export function createOutboundRouter(options: {
  base: EvolutionClient;
  waha: Pick<WahaClient, 'sendText' | 'sendMedia' | 'sendVoice' | 'sendContact'> & Partial<Pick<WahaClient, 'deleteMessage' | 'editMessage' | 'getContactProfilePicture' | 'checkNumber' | 'getGroup'>> | null;
  db: Db;
  campaignPrisma?: PrismaClient;
  journal: OutboundDispatchJournal;
  probe?: DeliveryProbe;
  probeDelayMs?: number;
  /** Reaches a media URL the WAHA API cannot read itself (it only accepts bytes). */
  fetchBinary?: (url: string, mimeType: string) => Promise<Buffer>;
  /** Called when a connection provably could not send, so health tracking can react at once. */
  onNotDelivered?: (connection: ConnectionRef, error: unknown) => void;
  now?: () => Date;
  logger?: { warn(fields: Record<string, unknown>, message: string): void };
  /** Staged rollout: workspaces this router handles. Every other workspace sends exactly as before (no journal). */
  routes?: (workspaceId: string) => boolean;
}): EvolutionClient {
  const { base, waha, db, journal } = options;
  const now = options.now ?? (() => new Date());
  const sleep = (ms: number) => ms > 0 ? new Promise<void>(resolve => setTimeout(resolve, ms)) : Promise.resolve();

  async function loadChannel(input: CommandScope) {
    // The provider shares one physical namespace across all workspaces. A scoped command cannot
    // make a colliding physical session safe; reject the collision before every provider call.
    const owners = await db.channel.findMany({ where: { providerKey: input.instanceName }, take: 2,
      select: { id: true, workspaceId: true, redundancyEnabled: true, activeConnectionId: true, archivedAt: true, providerInstanceClaim: true, verifiedMessagingPhoneNumber: true } });
    if (owners.length !== 1) throw new Error(owners.length ? 'CHANNEL_PROVIDER_KEY_AMBIGUOUS' : 'CHANNEL_NOT_FOUND');
    const channel = owners[0]!;
    if (channel.archivedAt || (input.workspaceId !== undefined && input.workspaceId !== channel.workspaceId)
      || (input.channelId !== undefined && input.channelId !== channel.id)) throw new Error('CHANNEL_SCOPE_MISMATCH');
    const connections = await db.channelConnection.findMany({ where: { workspaceId: channel.workspaceId, channelId: channel.id } });
    if (connections.length) {
      const physicalOwners = await db.channelConnection.findMany({ where: { OR: connections.map(connection => ({ provider: connection.provider, sessionName: connection.sessionName })) } });
      for (const connection of connections) {
        const owners = physicalOwners.filter(owner => owner.provider === connection.provider && owner.sessionName === connection.sessionName);
        if (owners.length !== 1 || owners[0]!.id !== connection.id || owners[0]!.workspaceId !== channel.workspaceId || owners[0]!.channelId !== channel.id)
          throw new Error('CHANNEL_PHYSICAL_SESSION_AMBIGUOUS');
      }
    }
    if (connections.some(connection => connection.provider === 'evolution' && connection.sessionName !== input.instanceName)) throw new Error('CHANNEL_PRIMARY_SESSION_MISMATCH');
    const refs: ConnectionRef[] = connections.map(connection => ({ id: connection.id, provider: connection.provider, status: connection.status, health: connection.health,
      eligible: connection.eligible, lifecycleGeneration: connection.lifecycleGeneration, verifiedPhoneNumber: connection.verifiedPhoneNumber,
      lastHealthyAt: connection.lastHealthyAt, sessionName: connection.sessionName }));
    const routable: RoutableChannel & { id: string; workspaceId: string; connections: ConnectionRef[]; providerInstanceClaim: string | null } = { id: channel.id, workspaceId: channel.workspaceId, providerInstanceClaim: channel.providerInstanceClaim,
      redundancyEnabled: channel.redundancyEnabled, activeConnectionId: channel.activeConnectionId, verifiedMessagingPhoneNumber: channel.verifiedMessagingPhoneNumber, connections: refs };
    return routable;
  }

  const chatId = (number: string) => number.includes('@') ? number : `${number.replace(/\D/g, '')}@c.us`;
  const stanzaId = (raw: unknown) => {
    const id = typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown }).id === 'string' ? (raw as { id: string }).id : null;
    return id ? parseWahaMessageKey(id).rawId ?? id : null;
  };

  async function binary(data: string, mimeType: string) {
    const trimmed = data.trim();
    const dataUrl = /^data:[^,]+;base64,(.+)$/is.exec(trimmed);
    if (dataUrl) return dataUrl[1]!;
    if (!/^https?:\/\//i.test(trimmed)) return trimmed; // already base64
    const bytes = options.fetchBinary
      ? await options.fetchBinary(trimmed, mimeType)
      : (await resolveAgentMedia({ mediaUrl: trimmed, policy: { kind: 'document', maxBytes: 25 * 1024 * 1024, allowedMimeTypes: new Set([mimeType.split(';')[0]!.trim().toLowerCase()]) } })).bytes;
    return Buffer.from(bytes).toString('base64');
  }

  /** One attempt on one physical connection. Evolution keeps its exact legacy call; WAHA maps the same command. */
  async function sendVia(connection: ConnectionRef, command: Command): Promise<Sent> {
    if (connection.provider === 'evolution') {
      const input = { ...command.input, instanceName: connection.sessionName };
      switch (command.kind) {
        case 'text': return base.sendText({ ...command.input, instanceName: input.instanceName });
        case 'media': return base.sendMedia({ ...command.input, instanceName: input.instanceName });
        case 'audio': if (!base.sendAudio) throw new Error('AUDIO_NOT_SUPPORTED'); return base.sendAudio({ ...command.input, instanceName: input.instanceName });
        case 'template': if (!base.sendTemplate) throw new Error('TEMPLATE_NOT_SUPPORTED'); return base.sendTemplate({ ...command.input, instanceName: input.instanceName });
        case 'edit': if (!base.editMessage) throw new Error('EDIT_NOT_SUPPORTED'); await base.editMessage({ ...command.input, instanceName: input.instanceName }); return { providerMessageId: command.input.id, raw: {} };
        case 'delete': if (!base.deleteMessageForEveryone) throw new Error('DELETE_NOT_SUPPORTED'); await base.deleteMessageForEveryone({ ...command.input, instanceName: input.instanceName }); return { providerMessageId: command.input.id, raw: {} };
        case 'contact': if (!base.sendContact) throw new Error('CONTACT_NOT_SUPPORTED'); return base.sendContact({ ...command.input, instanceName: input.instanceName });
      }
    }
    if (!waha) throw new Error('WAHA_NOT_CONFIGURED');
    if (command.kind === 'template') throw Object.assign(new Error('TEMPLATE_NOT_SUPPORTED'), { statusCode: 422 });
    const session = connection.sessionName, id = await resolveWahaDestination(waha, session, command.destination);
    switch (command.kind) {
      case 'edit': {
        if (!waha.editMessage) throw Object.assign(new Error('EDIT_NOT_SUPPORTED'), { statusCode: 422 });
        await waha.editMessage({ session, chatId: id, messageId: `true_${id}_${command.input.id}`, text: command.input.text });
        return { providerMessageId: command.input.id, raw: {} };
      }
      case 'delete': {
        if (!waha.deleteMessage) throw Object.assign(new Error('DELETE_NOT_SUPPORTED'), { statusCode: 422 });
        await waha.deleteMessage({ session, chatId: id, messageId: `true_${id}_${command.input.id}` });
        return { providerMessageId: command.input.id, raw: {} };
      }
      case 'text': {
        const quoted = command.input.quoted;
        // WAHA replies by the quoted message's serialized id: <fromMe>_<chat>_<stanza>[_<participant>] (group members).
        const replyTo = quoted ? `${quoted.fromMe}_${id}_${quoted.id}${id.endsWith('@g.us') && quoted.participant ? `_${quoted.participant.replace('@s.whatsapp.net', '@c.us')}` : ''}` : undefined;
        const sent = await waha.sendText({ session, chatId: id, text: command.input.text, linkPreview: command.input.linkPreview, ...(replyTo ? { replyTo } : {}) });
        return { providerMessageId: stanzaId(sent.raw) ?? sent.providerMessageId, raw: sent.raw };
      }
      case 'media': {
        const mimetype = command.input.mimetype, data = await binary(command.input.media, mimetype);
        const kind = command.input.mediatype === 'document' ? 'file' : command.input.mediatype;
        const sent = await waha.sendMedia({ session, chatId: id, kind, data, mimetype, filename: command.input.fileName, caption: command.input.caption });
        return { providerMessageId: stanzaId(sent.raw) ?? sent.providerMessageId, raw: sent.raw };
      }
      case 'audio': {
        // Sent as a voice note (push-to-talk), never as a file; WAHA converts the container itself.
        const data = await binary(command.input.audio, 'audio/ogg');
        const sent = await waha.sendVoice({ session, chatId: id, data, mimetype: 'audio/ogg; codecs=opus', filename: 'voice.ogg' });
        return { providerMessageId: stanzaId(sent.raw) ?? sent.providerMessageId, raw: sent.raw };
      }
      case 'contact': {
        const sent = await waha.sendContact({ session, chatId: id, contacts: command.input.contact.map(contact => ({ fullName: contact.fullName, phoneNumber: contact.phoneNumber, whatsappId: contact.wuid })) });
        return { providerMessageId: stanzaId(sent.raw) ?? sent.providerMessageId, raw: sent.raw };
      }
    }
  }

  async function route(input: CommandScope, command: Command, legacy: () => Promise<Sent>): Promise<Sent> {
    const channel = await loadChannel(input);
    const contextual = command.kind === 'text' && command.input.contextualFollowupMessageId;
    if (options.routes && !options.routes(channel.workspaceId)) {
      if (contextual) throw new ContextualFollowupBlocked('Canonical routing disabled');
      return legacy();
    }
    const candidates = writerCandidates(channel) as ConnectionRef[];
    if (!candidates.length) throw new Error('NO_CONNECTION_AVAILABLE');
    if (command.kind === 'text' && contextual) {
      if (!options.campaignPrisma) throw new ContextualFollowupBlocked('Canonical source unavailable');
      const connection = candidates[0]!;
      return sendCanonicalFollowupText({ prisma: options.campaignPrisma, workspaceId: channel.workspaceId, channelId: channel.id,
        messageId: contextual, connectionId: connection.id, provider: connection.provider, text: command.input.text,
        send: () => dispatch(channel, [connection], command) });
    }
    if (command.kind === 'text' && command.input.prospectingMessageId && options.campaignPrisma) {
      const connection = candidates[0]!;
      return sendCanonicalProspectingText({ prisma: options.campaignPrisma, workspaceId: channel.workspaceId,
        channelId: channel.id, messageId: command.input.prospectingMessageId, connectionId: connection.id,
        provider: connection.provider, text: command.input.text,
        send: () => dispatch(channel, [connection], command) });
    }
    return dispatch(channel, candidates, command);
  }

  // A persisted intention is mandatory. A journal error after I/O must never be interpreted
  // as a provider rejection and must never unlock the next writer.
  async function dispatch(channel: Awaited<ReturnType<typeof loadChannel>>, candidates: ConnectionRef[], command: Command): Promise<Sent> {
    const dispatchId = await journal.begin({ workspaceId: channel.workspaceId, channelId: channel.id, kind: command.kind, destination: command.destination, text: command.text });
    const startedAt = now();
    const uncertain = async (error: unknown): Promise<never> => {
      try { await journal.markUncertain(dispatchId, errorCode(error)); }
      catch (journalError) { options.logger?.warn({ err: journalError, dispatchId }, 'Outbound uncertainty could not be recorded; durable intention remains for recovery'); }
      throw new OutboundUncertainError(dispatchId, error);
    };
    let lastError: unknown = null;
    for (const connection of candidates) {
      let sent: Sent;
      try { sent = await sendVia(connection, command); }
      catch (error) {
        lastError = error;
        const outcome = classifySendFailure(error);
        try { await journal.recordAttempt(dispatchId, { connectionId: connection.id, provider: connection.provider, outcome, code: errorCode(error) }); }
        catch (journalError) { return uncertain(journalError); }
        if (outcome === 'uncertain') {
          const found = await probeAll(channel.connections, command, startedAt);
          if (found) {
            try { await journal.accept(dispatchId, { connectionId: found.connection.id, providerMessageId: found.providerMessageId }); }
            catch (journalError) { return uncertain(journalError); }
            return { providerMessageId: found.providerMessageId, raw: { recoveredByProbe: true } };
          }
          return uncertain(error);
        }
        if (!(error instanceof WahaDestinationError)) options.onNotDelivered?.(connection, error);
        continue;
      }
      try {
        await journal.recordAttempt(dispatchId, { connectionId: connection.id, provider: connection.provider, outcome: 'accepted', code: null });
        await journal.accept(dispatchId, { connectionId: connection.id, providerMessageId: sent.providerMessageId });
      } catch (journalError) { return uncertain(journalError); }
      return sent;
    }
    await journal.fail(dispatchId, errorCode(lastError));
    throw lastError ?? new Error('NO_CONNECTION_AVAILABLE');
  }

  /** After an uncertain failure, ask every connection whether the message is already in the chat. */
  async function probeAll(connections: ConnectionRef[], command: Command, since: Date) {
    if (!options.probe) return null;
    await sleep(options.probeDelayMs ?? 3_000);
    for (const connection of connections) {
      if (connection.status !== 'connected') continue;
      try {
        const result = await options.probe({ connection, destination: command.destination, kind: command.kind, text: command.text, since });
        if (result !== 'unknown' && result.found) return { connection, providerMessageId: result.providerMessageId };
      } catch (error) { options.logger?.warn({ err: error, connectionId: connection.id }, 'Delivery probe failed'); }
    }
    return null;
  }

  const router: EvolutionClient = {
    ...base,
    supportsCanonicalFollowups: !!options.campaignPrisma,
    sendText: (input: SendTextInput): Promise<SendTextResult> => route(input, { kind: 'text', destination: input.number, text: input.text, input }, () => base.sendText(input)),
    sendMedia: (input: SendMediaInput): Promise<SendMediaResult> => route(input, { kind: 'media', destination: input.number, text: input.caption ?? null, input }, () => base.sendMedia(input))
  };
  if (options.campaignPrisma) router.sendCampaignText = async input => {
    const channel = await loadChannel(input);
    if (!channel) throw new Error('Campaign channel unavailable');
    if (options.routes && !options.routes(channel.workspaceId)) return router.sendText(input);
    const connection = writerCandidates(channel)[0] as ConnectionRef | undefined;
    if (!connection) throw new Error('Campaign writer unavailable');
    return sendCanonicalCampaignText({ prisma: options.campaignPrisma!, workspaceId: channel.workspaceId,
      channelId: channel.id, recipientId: input.recipientId, leaseToken: input.leaseToken,
      connectionId: connection.id, provider: connection.provider, text: input.text,
      send: () => dispatch(channel, [connection], { kind: 'text', destination: input.number, text: input.text, input }) });
  };
  if (base.deleteMessageForEveryone || waha?.deleteMessage) router.deleteMessageForEveryone = async input => {
    await route(input, { kind: 'delete', destination: input.remoteJid.replace('@s.whatsapp.net', '@c.us'), text: null, input }, async () => {
      if (!base.deleteMessageForEveryone) throw new Error('DELETE_NOT_SUPPORTED');
      await base.deleteMessageForEveryone(input); return { providerMessageId: input.id, raw: {} };
    });
  };
  if (base.editMessage || waha?.editMessage) router.editMessage = async input => {
    await route(input, { kind: 'edit', destination: input.remoteJid.replace('@s.whatsapp.net', '@c.us'), text: input.text, input }, async () => {
      if (!base.editMessage) throw new Error('EDIT_NOT_SUPPORTED');
      await base.editMessage(input); return { providerMessageId: input.id, raw: {} };
    });
  };
  /** The number's WAHA session when it is connected and proven on the same phone, and whether Evolution is up. */
  async function reader(input: CommandScope) {
    const channel = await loadChannel(input);
    if (options.routes && !options.routes(channel.workspaceId)) return null;
    const candidates = writerCandidates(channel);
    if (!candidates.length) throw new Error('NO_CONNECTION_AVAILABLE');
    const secondary = candidates.find(connection => connection.provider === 'waha') as ConnectionRef | undefined;
    return secondary ? { session: secondary.sessionName, evolutionUp: candidates.some(connection => connection.provider === 'evolution') } : null;
  }
  /** Reads (pictures, numbers, groups) the same way through either session: WAHA answers while Evolution is down,
   * and also when Evolution fails. */
  async function read<T>(input: CommandScope, evolution: (() => Promise<T>) | undefined, viaWaha: ((session: string) => Promise<T>) | null) {
    const alternative = await reader(input);
    if (alternative && viaWaha && (!alternative.evolutionUp || !evolution)) return viaWaha!(alternative.session);
    if (!evolution) throw new Error('READ_UNAVAILABLE');
    try { return await evolution(); } catch (error) { if (!alternative || !viaWaha) throw error; return viaWaha!(alternative.session); }
  }
  if (base.fetchProfilePicture || waha?.getContactProfilePicture) router.fetchProfilePicture = input => read(input,
    base.fetchProfilePicture ? () => base.fetchProfilePicture!(input) : undefined,
    waha?.getContactProfilePicture ? async session => {
      const result = await waha.getContactProfilePicture!({ session, contactId: chatId(input.number) });
      const url = typeof result?.profilePictureURL === 'string' ? result.profilePictureURL : null;
      return url && url.startsWith('https://') ? url : null;
    } : null);
  if (base.getGroupInfo || waha?.getGroup) router.getGroupInfo = input => read(input,
    base.getGroupInfo ? () => base.getGroupInfo!(input) : undefined,
    waha?.getGroup ? async session => {
      const group = await waha.getGroup!({ session, groupId: input.groupJid }) as { subject?: unknown; name?: unknown } | null;
      const subject = [group?.subject, group?.name].find((value): value is string => typeof value === 'string' && value.trim().length > 0);
      return { subject: subject?.trim() ?? null };
    } : null);
  if (base.checkWhatsappNumbersAvailability || waha?.checkNumber) router.checkWhatsappNumbersAvailability = input => read(input,
    base.checkWhatsappNumbersAvailability ? () => base.checkWhatsappNumbersAvailability!(input) : undefined,
    waha?.checkNumber ? async session => {
      const numbers = [];
      for (const phone of input.numbers) {
        const result = await waha.checkNumber!({ session, phone: phone.replace(/\D/g, '') });
        numbers.push({ phone, available: result?.numberExists === true, ...(typeof result?.chatId === 'string' ? { jid: result.chatId.replace('@c.us', '@s.whatsapp.net') } : {}) });
      }
      return { numbers, raw: { provider: 'waha' } };
    } : null);
  // Lifecycle/read passthroughs still share the global namespace and must not bypass ownership.
  router.createInstance = async input => { await loadChannel(input); return base.createInstance(input); };
  router.connectInstance = async input => {
    const channel = await loadChannel(input);
    if (channel.providerInstanceClaim !== input.instanceName) throw new Error('CHANNEL_PROVIDER_OWNERSHIP_UNVERIFIED');
    return base.connectInstance(input);
  };
  router.setWebhook = async input => {
    const channel = await loadChannel(input);
    if (channel.providerInstanceClaim !== input.instanceName) throw new Error('CHANNEL_PROVIDER_OWNERSHIP_UNVERIFIED');
    return base.setWebhook(input);
  };
  if (base.getInstanceIdentity) router.getInstanceIdentity = async input => { await loadChannel(input); return base.getInstanceIdentity!(input); };
  if (base.getConnectionState) router.getConnectionState = async input => { await loadChannel(input); return base.getConnectionState!(input); };
  if (base.logoutInstance) router.logoutInstance = async input => { await loadChannel(input); return base.logoutInstance!(input); };
  if (base.sendTemplate) router.sendTemplate = input => route(input, { kind: 'template', destination: input.number, text: null, input }, () => base.sendTemplate!(input));
  if (base.fetchMedia) router.fetchMedia = async input => { await loadChannel(input); return base.fetchMedia!(input); };
  if (base.listTemplates) router.listTemplates = async input => { await loadChannel(input); return base.listTemplates!(input); };
  if (base.sendAudio || waha) router.sendAudio = input => route(input, { kind: 'audio', destination: input.number, text: null, input }, () => { if (!base.sendAudio) throw new Error('AUDIO_NOT_SUPPORTED'); return base.sendAudio(input); });
  if (base.sendContact || waha) router.sendContact = input => route(input, { kind: 'contact', destination: input.number, text: null, input }, () => { if (!base.sendContact) throw new Error('CONTACT_NOT_SUPPORTED'); return base.sendContact(input); });
  return router;
}

function errorCode(error: unknown): string {
  if (error instanceof AgentMediaError) return error.code;
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === 'number') return `HTTP_${status}`;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code.slice(0, 60);
  return error instanceof Error ? error.name.slice(0, 60) : 'UNKNOWN';
}
