import type { PrismaClient } from '@prisma/client';
import { AgentMediaError, resolveAgentMedia } from '../agents/agent-media-resolver.js';
import type { EvolutionClient, SendContactInput, SendMediaInput, SendMediaResult, SendTextInput, SendTextResult } from '../evolution/evolution.client.js';
import { parseWahaMessageKey } from '../messaging/whatsapp-identity.js';
import type { WahaClient } from '../waha/waha.client.js';
import type { DispatchKind, OutboundDispatchJournal } from './outbound-dispatch-journal.js';
import { classifySendFailure, writerCandidates, type RoutableChannel, type RoutableConnection } from './outbound-routing.js';

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
export type DeliveryProbe = (input: { connection: ConnectionRef; destination: string; kind: DispatchKind; text: string | null; since: Date }) => Promise<ProbeResult>;
export type ConnectionRef = RoutableConnection & { sessionName: string };

type Db = Pick<PrismaClient, 'channel' | 'channelConnection' | 'outboundDispatch' | '$executeRaw'>;
type Sent = { providerMessageId: string | null; raw: unknown };
type Command =
  | { kind: 'text'; destination: string; text: string; input: SendTextInput }
  | { kind: 'media'; destination: string; text: string | null; input: SendMediaInput }
  | { kind: 'audio'; destination: string; text: null; input: { instanceName: string; number: string; audio: string } }
  | { kind: 'contact'; destination: string; text: null; input: SendContactInput };

export function createOutboundRouter(options: {
  base: EvolutionClient;
  waha: Pick<WahaClient, 'sendText' | 'sendMedia' | 'sendVoice' | 'sendContact'> & Partial<Pick<WahaClient, 'deleteMessage' | 'editMessage'>> | null;
  db: Db;
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

  async function loadChannel(instanceName: string) {
    const channel = await db.channel.findFirst({ where: { provider: 'evolution', providerKey: instanceName },
      select: { id: true, workspaceId: true, redundancyEnabled: true, activeConnectionId: true } });
    if (!channel) return null;
    const connections = await db.channelConnection.findMany({ where: { workspaceId: channel.workspaceId, channelId: channel.id } });
    const refs: ConnectionRef[] = connections.map(connection => ({ id: connection.id, provider: connection.provider, status: connection.status, health: connection.health,
      eligible: connection.eligible, verifiedPhoneNumber: connection.verifiedPhoneNumber, lastHealthyAt: connection.lastHealthyAt, sessionName: connection.sessionName }));
    const routable: RoutableChannel & { id: string; workspaceId: string; connections: ConnectionRef[] } = { id: channel.id, workspaceId: channel.workspaceId,
      redundancyEnabled: channel.redundancyEnabled, activeConnectionId: channel.activeConnectionId, connections: refs };
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
      switch (command.kind) {
        case 'text': return base.sendText(command.input);
        case 'media': return base.sendMedia(command.input);
        case 'audio': if (!base.sendAudio) throw new Error('AUDIO_NOT_SUPPORTED'); return base.sendAudio(command.input);
        case 'contact': if (!base.sendContact) throw new Error('CONTACT_NOT_SUPPORTED'); return base.sendContact(command.input);
      }
    }
    if (!waha) throw new Error('WAHA_NOT_CONFIGURED');
    const session = connection.sessionName, id = chatId(command.destination);
    switch (command.kind) {
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

  async function route(instanceName: string, command: Command, legacy: () => Promise<Sent>): Promise<Sent> {
    let channel: Awaited<ReturnType<typeof loadChannel>>;
    try { channel = await loadChannel(instanceName); }
    catch (error) { options.logger?.warn({ err: error }, 'Outbound router could not load the channel; sending directly'); return legacy(); }
    if (!channel) return legacy();
    if (options.routes && !options.routes(channel.workspaceId)) return legacy();

    let dispatchId: string | null = null;
    try { dispatchId = await journal.begin({ workspaceId: channel.workspaceId, channelId: channel.id, kind: command.kind, destination: command.destination, text: command.text }); }
    catch (error) { options.logger?.warn({ err: error }, 'Outbound journal unavailable; sending without a record'); }
    const track = async (work: () => Promise<unknown>) => { if (dispatchId) { try { await work(); } catch (error) { options.logger?.warn({ err: error, dispatchId }, 'Outbound journal write failed'); } } };

    const startedAt = now();
    const candidates = writerCandidates(channel);
    // Nothing is allowed to write (or redundancy is off): keep the legacy call and its exact error semantics.
    const attemptOrder = candidates.length ? candidates as ConnectionRef[] : [channel.connections.find(connection => connection.provider === 'evolution')].filter((connection): connection is ConnectionRef => !!connection);
    let lastError: unknown = null;
    for (const connection of attemptOrder) {
      try {
        const sent = await sendVia(connection, command);
        await track(async () => { await journal.recordAttempt(dispatchId!, { connectionId: connection.id, provider: connection.provider, outcome: 'accepted', code: null }); await journal.accept(dispatchId!, { connectionId: connection.id, providerMessageId: sent.providerMessageId }); });
        return sent;
      } catch (error) {
        lastError = error;
        const outcome = classifySendFailure(error);
        await track(() => journal.recordAttempt(dispatchId!, { connectionId: connection.id, provider: connection.provider, outcome, code: errorCode(error) }));
        if (outcome === 'uncertain') {
          const found = await probeAll(channel.connections, command, startedAt);
          if (found) {
            await track(() => journal.accept(dispatchId!, { connectionId: found.connection.id, providerMessageId: found.providerMessageId }));
            return { providerMessageId: found.providerMessageId, raw: { recoveredByProbe: true } };
          }
          await track(() => journal.markUncertain(dispatchId!, errorCode(error)));
          throw dispatchId ? new OutboundUncertainError(dispatchId, error) : error;
        }
        options.onNotDelivered?.(connection, error);
      }
    }
    await track(() => journal.fail(dispatchId!, errorCode(lastError)));
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
    sendText: (input: SendTextInput): Promise<SendTextResult> => route(input.instanceName, { kind: 'text', destination: input.number, text: input.text, input }, () => base.sendText(input)),
    sendMedia: (input: SendMediaInput): Promise<SendMediaResult> => route(input.instanceName, { kind: 'media', destination: input.number, text: input.caption ?? null, input }, () => base.sendMedia(input))
  };
  // Delete for everyone: Evolution as before; in routed workspaces, when Evolution cannot, the WAHA connection of the
  // same number revokes it (WhatsApp accepts the revoke from any linked device of the sender).
  if (base.deleteMessageForEveryone) router.deleteMessageForEveryone = async input => {
    try { return await base.deleteMessageForEveryone!(input); }
    catch (error) {
      const channel = waha?.deleteMessage ? await loadChannel(input.instanceName) : null;
      if (!channel || (options.routes && !options.routes(channel.workspaceId))) throw error;
      const alternative = writerCandidates(channel).find(connection => connection.provider === 'waha') as ConnectionRef | undefined;
      if (!alternative) throw error;
      const chat = chatId(input.remoteJid.replace('@s.whatsapp.net', '@c.us'));
      await waha!.deleteMessage!({ session: alternative.sessionName, chatId: chat, messageId: `true_${chat}_${input.id}` });
    }
  };
  // Edit: same fallback as delete, through the WAHA connection of the same number.
  if (base.editMessage) router.editMessage = async input => {
    try { return await base.editMessage!(input); }
    catch (error) {
      const channel = waha?.editMessage ? await loadChannel(input.instanceName) : null;
      if (!channel || (options.routes && !options.routes(channel.workspaceId))) throw error;
      const alternative = writerCandidates(channel).find(connection => connection.provider === 'waha') as ConnectionRef | undefined;
      if (!alternative) throw error;
      const chat = chatId(input.remoteJid.replace('@s.whatsapp.net', '@c.us'));
      await waha!.editMessage!({ session: alternative.sessionName, chatId: chat, messageId: `true_${chat}_${input.id}`, text: input.text });
    }
  };
  if (base.sendAudio) router.sendAudio = input => route(input.instanceName, { kind: 'audio', destination: input.number, text: null, input }, () => base.sendAudio!(input));
  if (base.sendContact) router.sendContact = input => route(input.instanceName, { kind: 'contact', destination: input.number, text: null, input }, () => base.sendContact!(input));
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
