import { completeProviderKey, fullProviderKeyMatches, exactMediaLimit, type MediaPurpose } from '../messaging/provider-exact.js';
import { normalizeChatAddress, parseWahaMessageKey, record, type WhatsAppMessageKey } from '../messaging/whatsapp-identity.js';
/** WAHA 2026.9.1 contracts: https://github.com/devlikeapro/waha/tree/2026.9.1/src/api */
export class WahaClientError extends Error {
  constructor(public readonly statusCode: number) {
    super(`WAHA request failed (${statusCode})`);
    this.name = 'WahaClientError';
  }
}

export interface WahaMe {
  id: string;
  pushName?: string;
  reachoutTimelock?: { isActive: boolean } | null;
  messageCapping?: { cappingStatus: string } | null;
}
export interface WahaSession {
  name: string;
  status: 'STOPPED' | 'STARTING' | 'SCAN_QR_CODE' | 'WORKING' | 'FAILED' | 'PASSKEY_REQUIRED' | 'PASSKEY_CONFIRMATION_REQUIRED';
  config?: { metadata?: Record<string, string> };
  engine?: { engine?: string };
  me?: WahaMe | null;
}
export interface WahaMessage {
  id: string;
  timestamp?: number;
  from?: string;
  to?: string;
  fromMe?: boolean;
  body?: string;
  hasMedia?: boolean;
  media?: { url: string; mimetype?: string; filename?: string } | null;
  ack?: number;
  [key: string]: unknown;
}
type SessionInput = { session: string };
type ChatInput = SessionInput & { chatId: string };
type BinaryFile = { data: string; mimetype: string; filename: string };
type Page = { limit?: number; offset?: number };
type ContactInput = SessionInput & { contactId: string };
type GroupInput = SessionInput & { groupId: string };

export function createWahaClient(options: { baseUrl: string; apiKey: string; fetch?: typeof fetch; timeoutMs?: number; maxMediaBytes?: number }) {
  const base = new URL(options.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('Invalid WAHA API base URL');
  }
  const baseUrl = base.toString().replace(/\/$/, '');
  const fetcher = options.fetch ?? fetch;
  const enc = encodeURIComponent;
  const query = (values: Record<string, string | number | boolean | undefined>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value));
    const text = params.toString();
    return text ? `?${text}` : '';
  };
  async function response(url: string, method = 'GET', body?: unknown) {
    const result = await fetcher(url, {
      method, redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      headers: { 'X-Api-Key': options.apiKey, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!result.ok) throw new WahaClientError(result.status);
    return result;
  }
  async function request<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const result = await response(`${baseUrl}${path}`, method, body);
    const text = await result.text();
    return (text ? JSON.parse(text) : null) as T;
  }
  const file = (input: BinaryFile) => ({ data: input.data, mimetype: input.mimetype, filename: input.filename });
  async function send(path: string, body: unknown) {
    const raw = await request<WahaMessage>(path, 'POST', body);
    if (!raw || typeof raw.id !== 'string' || !raw.id) throw new Error('WAHA returned no message identity');
    return { providerMessageId: raw.id, raw };
  }
  const sessions = (input: SessionInput) => `/api/sessions/${enc(input.session)}`;
  const chats = (input: ChatInput) => `/api/${enc(input.session)}/chats/${enc(input.chatId)}`;
  const messagePath = (input: ChatInput & { messageId: string }) => `${chats(input)}/messages/${enc(input.messageId)}`;
  async function getMediaBytes(input: { url: string; maxBytes?: number }): Promise<Uint8Array> {
      const url = new URL(input.url, base);
      if (url.origin !== base.origin || url.username || url.password || !url.pathname.startsWith('/api/files/') || url.hash) {
        throw new Error('WAHA media URL must belong to the configured file origin');
      }
      const result = await response(url.toString());
      const maxBytes = Math.min(input.maxBytes ?? Infinity, options.maxMediaBytes ?? 50 * 1024 * 1024);
      if (Number(result.headers.get('content-length')) > maxBytes) {
        await result.body?.cancel();
        throw new Error('WAHA media exceeds size limit');
      }
      const reader = result.body?.getReader();
      if (!reader) return new Uint8Array();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) throw new Error('WAHA media exceeds size limit');
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes;
    }
  async function findMessageExact(input: { session: string; key: WhatsAppMessageKey }, downloadMedia = false): Promise<
    { kind: 'resolved'; message: WahaMessage } | { kind: 'missing' | 'incomplete' | 'ambiguous' }> {
    if (!input.session || !completeProviderKey(input.key)) return { kind: 'incomplete' };
    let message: WahaMessage;
    try { message = await request<WahaMessage>(`${messagePath({ session: input.session, chatId: input.key.nativeChatAddress!, messageId: input.key.nativeId! })}?downloadMedia=${downloadMedia}`); }
    catch (error) { if (error instanceof WahaClientError && error.statusCode === 404) return { kind: 'missing' }; throw error; }
    if (Array.isArray(message)) return { kind: 'ambiguous' };
    if (!message || typeof message.id !== 'string') return { kind: 'missing' };
    const raw = record(message._data);
    const actual = parseWahaMessageKey(raw.id ?? message.id, raw.author ?? message.participant);
    actual.nativeId = message.id;
    const serialized = parseWahaMessageKey(message.id, actual.nativeSenderParticipant);
    if (!completeProviderKey(serialized) || !fullProviderKeyMatches(actual, serialized)) return { kind: 'missing' };
    const structuredSerialized = record(raw.id)._serialized;
    if (typeof structuredSerialized === 'string' && structuredSerialized !== message.id) return { kind: 'missing' };
    const envelopeChat = message.fromMe === true ? message.to : message.fromMe === false ? message.from : undefined;
    if (envelopeChat !== undefined && normalizeChatAddress(envelopeChat) !== actual.chatAddress) return { kind: 'missing' };
    for (const participant of [raw.author, message.participant]) {
      if (participant !== undefined && actual.chatAddress?.endsWith('@g.us') && normalizeChatAddress(participant) !== actual.senderParticipant) return { kind: 'missing' };
    }
    if (typeof message.fromMe === 'boolean' && actual.direction !== (message.fromMe ? 'outbound' : 'inbound')) return { kind: 'missing' };
    if (!fullProviderKeyMatches(input.key, actual)) return { kind: 'missing' };
    return { kind: 'resolved', message };
  }
  return {
    findMessageExact,
    /** Network-only; a scoped exact lookup precedes media. Existing origin/redirect
     * checks remain in getMediaBytes, with caller-specific 25 MiB/8 MiB budgets. */
    async mediaExact(input: { session: string; key: WhatsAppMessageKey; purpose: MediaPurpose }) {
      const found = await findMessageExact(input, true);
      if (found.kind !== 'resolved') return found;
      if (!found.message.media?.url) return { kind: 'missing' as const };
      const bytes = await getMediaBytes({ url: found.message.media.url, maxBytes: exactMediaLimit(input.purpose) });
      return { kind: 'resolved' as const, message: found.message, bytes };
    },
    getVersion: () => request<{ version: string; engine: string }>('/api/server/version'),
    createSession(input: SessionInput & { workspaceId: string; channelId: string }) {
      return request<WahaSession>('/api/sessions', 'POST', { name: input.session, start: false, config: { metadata: { workspaceId: input.workspaceId, channelId: input.channelId } } });
    },
    startSession: (input: SessionInput) => request<WahaSession>(`${sessions(input)}/start`, 'POST'),
    stopSession: (input: SessionInput) => request<WahaSession>(`${sessions(input)}/stop`, 'POST'),
    logoutSession: (input: SessionInput) => request<WahaSession>(`${sessions(input)}/logout`, 'POST'),
    deleteSession: (input: SessionInput) => request<void>(sessions(input), 'DELETE'),
    getSession: (input: SessionInput) => request<WahaSession>(sessions(input)),
    getMe: (input: SessionInput) => request<WahaMe | null>(`${sessions(input)}/me`),
    async getQr(input: SessionInput) {
      const qr = await request<{ value?: string }>(`/api/${enc(input.session)}/auth/qr?format=raw`);
      if (!qr || typeof qr.value !== 'string' || !qr.value) throw new Error('WAHA returned no QR code');
      return qr.value;
    },
    getChats: (input: SessionInput & Page) => request<Array<{ id: string; name?: string }>>(`/api/${enc(input.session)}/chats${query({ limit: input.limit ?? 100, offset: input.offset ?? 0 })}`),
    getMessages: (input: ChatInput & Page) => request<WahaMessage[]>(`${chats(input)}/messages${query({ limit: input.limit ?? 100, offset: input.offset ?? 0, downloadMedia: false })}`),
    /** Legacy unvalidated API. Canonical callers must use findMessageExact. */
    getMessage: (input: ChatInput & { messageId: string }) => request<WahaMessage>(`${messagePath(input)}?downloadMedia=true`),
    deleteMessage: (input: ChatInput & { messageId: string }) => request<void>(messagePath(input), 'DELETE'),
    sendText: (input: ChatInput & { text: string; linkPreview?: boolean; replyTo?: string }) => send('/api/sendText', { session: input.session, chatId: input.chatId, text: input.text, ...(input.linkPreview === undefined ? {} : { linkPreview: input.linkPreview }), ...(input.replyTo ? { reply_to: input.replyTo } : {}) }),
    sendMedia: (input: ChatInput & BinaryFile & { kind: 'image' | 'video' | 'file'; caption?: string }) => send(`/api/${input.kind === 'image' ? 'sendImage' : input.kind === 'video' ? 'sendVideo' : 'sendFile'}`, { session: input.session, chatId: input.chatId, file: file(input), ...(input.caption === undefined ? {} : { caption: input.caption }) }),
    sendVoice: (input: ChatInput & BinaryFile) => send('/api/sendVoice', { session: input.session, chatId: input.chatId, file: file(input), convert: true }),
    sendContact: (input: ChatInput & { contacts: Array<{ fullName: string; phoneNumber: string; whatsappId?: string }> }) => send('/api/sendContactVcard', { session: input.session, chatId: input.chatId, contacts: input.contacts.map((contact) => ({ ...contact, vcard: null })) }),
    getGroups: (input: SessionInput & Page) => request<Record<string, unknown>>(`/api/${enc(input.session)}/groups${query({ limit: input.limit ?? 100, offset: input.offset ?? 0 })}`),
    getGroup: (input: GroupInput) => request<{ id: string; subject?: string }>(`/api/${enc(input.session)}/groups/${enc(input.groupId)}`),
    getGroupParticipants: (input: GroupInput) => request<Array<{ id: string; isAdmin?: boolean }>>(`/api/${enc(input.session)}/groups/${enc(input.groupId)}/participants`),
    getContacts: (input: SessionInput & Page) => request<Array<{ id: string; name?: string }>>(`/api/contacts/all${query({ session: input.session, limit: input.limit ?? 100, offset: input.offset ?? 0 })}`),
    getContact: (input: ContactInput) => request<{ id: string; name?: string }>(`/api/contacts${query(input)}`),
    getContactProfilePicture: (input: ContactInput) => request<{ profilePictureURL: string | null }>(`/api/contacts/profile-picture${query(input)}`),
    getProfile: (input: SessionInput) => request<{ id: string; name?: string; picture?: string }>(`/api/${enc(input.session)}/profile`),
    checkNumber: (input: SessionInput & { phone: string }) => request<{ numberExists: boolean; chatId?: string }>(`/api/contacts/check-exists${query(input)}`),
    getMediaBytes
  };
}

export type WahaClient = ReturnType<typeof createWahaClient>;
export interface WahaRuntime { enabled: boolean; client: WahaClient | null }
export function createWahaRuntime(input: { enabled?: boolean; baseUrl?: string; apiKey?: string; fetch?: typeof fetch }): WahaRuntime {
  return { enabled: input.enabled === true, client: input.enabled && input.baseUrl && input.apiKey ? createWahaClient({ baseUrl: input.baseUrl, apiKey: input.apiKey, fetch: input.fetch }) : null };
}
