import { createHash } from 'node:crypto';

export type HistoryRecord = {
  key: { id: string; remoteJid: string; remoteJidAlt?: string; fromMe: boolean };
  messageTimestamp: number;
  message: Record<string, unknown>;
  messageType?: string;
  pushName?: string;
};
export type RecentEvolutionChat = { remoteJid: string; phoneJid: string; pushName: string | null; profilePicUrl: string | null };
export type RecentEvolutionChats = { chats: RecentEvolutionChat[]; unresolvedLids: number };
export type RecentEvolutionContact = { phoneJid: string; name: string | null; profilePicUrl: string | null };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const direct = (s: unknown): s is string => typeof s === 'string' && /^\d+@(s\.whatsapp\.net|lid)$/.test(s);
const phoneJid = (s: unknown): s is string => typeof s === 'string' && /^\d+@s\.whatsapp\.net$/.test(s);
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

// This adapter deliberately has no send, mark-read, webhook or instance mutation methods.
export function createEvolutionHistorySource(options: { baseUrl: string; apiKey: string; fetch?: typeof fetch }) {
  const request = options.fetch ?? fetch;
  async function post(path: string, body: unknown) {
    const response = await request(options.baseUrl.replace(/\/$/, '') + path, {
      method: 'POST', headers: { apikey: options.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`HISTORY_HTTP_${response.status}`);
    const text = await response.text();
    if (text.length > 16 * 1024 * 1024) throw new Error('HISTORY_RESPONSE_LIMIT');
    return JSON.parse(text) as unknown;
  }
  async function page(instance: string, key: Record<string, string>, index: number) {
    const data = await post(`/chat/findMessages/${encodeURIComponent(instance)}`, { where: { key }, page: index, offset: 100 });
    if (!record(data) || !record(data.messages) || !Array.isArray(data.messages.records) || !Number.isInteger(data.messages.pages) || Number(data.messages.pages) < 0) throw new Error('HISTORY_SHAPE');
    const pages = Number(data.messages.pages);
    if (pages > 50) throw new Error('HISTORY_PAGE_LIMIT');
    return { pages, records: data.messages.records };
  }
  function parse(value: unknown): HistoryRecord {
    if (!record(value) || !record(value.key) || typeof value.key.id !== 'string' || !value.key.id || !direct(value.key.remoteJid) || typeof value.key.fromMe !== 'boolean' || !record(value.message)) throw new Error('HISTORY_RECORD');
    const timestamp = Number(value.messageTimestamp);
    if (value.messageTimestamp === null || !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > 1e11) throw new Error('HISTORY_RECORD');
    return { key: { id: value.key.id, remoteJid: value.key.remoteJid, fromMe: value.key.fromMe,
      ...(direct(value.key.remoteJidAlt) ? { remoteJidAlt: value.key.remoteJidAlt } : {}) }, messageTimestamp: timestamp, message: value.message,
      ...(typeof value.messageType === 'string' ? { messageType: value.messageType } : {}),
      ...(typeof value.pushName === 'string' && value.pushName.trim() ? { pushName: value.pushName.trim().slice(0, 200) } : {}) };
  }
  return {
    async recentContacts(input: { instanceName: string }): Promise<RecentEvolutionContact[]> {
      const contacts = new Map<string, RecentEvolutionContact>();
      for (let offset = 0; offset < 20000; offset += 1000) {
        const data = await post(`/chat/findContacts/${encodeURIComponent(input.instanceName)}`, { take: 1000, skip: offset });
        const rows = Array.isArray(data) ? data : record(data) && Array.isArray(data.contacts) ? data.contacts : null;
        if (!rows) throw new Error('HISTORY_CONTACTS_SHAPE');
        for (const raw of rows) {
          if (!record(raw) || !direct(raw.remoteJid)) continue;
          const previous = contacts.get(raw.remoteJid);
          contacts.set(raw.remoteJid, {
            phoneJid: raw.remoteJid,
            name: typeof raw.pushName === 'string' && raw.pushName.trim() ? raw.pushName.trim().slice(0, 200) : previous?.name ?? null,
            profilePicUrl: typeof raw.profilePicUrl === 'string' && /^https:\/\//i.test(raw.profilePicUrl) ? raw.profilePicUrl : previous?.profilePicUrl ?? null
          });
        }
        if (rows.length < 1000) return [...contacts.values()];
      }
      throw new Error('HISTORY_CONTACT_LIMIT');
    },
    async recentChats(input: { instanceName: string; limit: number }): Promise<RecentEvolutionChats> {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000) throw new Error('HISTORY_CHAT_LIMIT');
      const chats: RecentEvolutionChat[] = [];
      const seen = new Set<string>();
      let unresolvedLids = 0;
      for (let offset = 0; offset < 10000 && chats.length < input.limit; offset += 100) {
        const data = await post(`/chat/findChats/${encodeURIComponent(input.instanceName)}`, { take: 100, skip: offset });
        const rows = Array.isArray(data) ? data : record(data) && Array.isArray(data.chats) ? data.chats : null;
        if (!rows) throw new Error('HISTORY_CHATS_SHAPE');
        for (const raw of rows) {
          if (!record(raw) || !direct(raw.remoteJid)) continue;
          const alternate = record(raw.lastMessage) && record(raw.lastMessage.key) ? raw.lastMessage.key.remoteJidAlt : null;
          const resolvedPhoneJid = phoneJid(raw.remoteJid) ? raw.remoteJid : phoneJid(raw.remoteJidAlt) ? raw.remoteJidAlt : phoneJid(alternate) ? alternate : null;
          // A LID is an addressable WhatsApp identity, but never a telephone number.
          // Keep its suffix so it cannot collide with a real contact's phone.
          const identity = resolvedPhoneJid ?? raw.remoteJid;
          if (!resolvedPhoneJid) unresolvedLids++;
          if (seen.has(identity)) continue;
          seen.add(identity);
          chats.push({
            remoteJid: raw.remoteJid,
            phoneJid: identity,
            pushName: typeof raw.pushName === 'string' && raw.pushName.trim() ? raw.pushName.trim().slice(0, 200) : null,
            profilePicUrl: typeof raw.profilePicUrl === 'string' && /^https:\/\//i.test(raw.profilePicUrl) ? raw.profilePicUrl : null
          });
          if (chats.length === input.limit) break;
        }
        if (rows.length < 100) break;
      }
      return { chats, unresolvedLids };
    },
    async recentMessages(input: { instanceName: string; remoteJid: string; limit: number }): Promise<HistoryRecord[]> {
      if (!direct(input.remoteJid)) throw new Error('HISTORY_IDENTITY');
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) throw new Error('HISTORY_MESSAGE_LIMIT');
      const rows: unknown[] = [];
      const pageSize = Math.min(input.limit, 100);
      for (let index = 1; rows.length < input.limit; index++) {
        const data = await post(`/chat/findMessages/${encodeURIComponent(input.instanceName)}`, {
          where: { key: { remoteJid: input.remoteJid } }, page: index, offset: pageSize
        });
        if (!record(data) || !record(data.messages) || !Array.isArray(data.messages.records)) throw new Error('HISTORY_SHAPE');
        rows.push(...data.messages.records.slice(0, input.limit - rows.length));
        const pages = Number(data.messages.pages);
        if (data.messages.records.length < pageSize || (Number.isInteger(pages) && index >= pages)) break;
      }
      const readable = rows.filter((raw) => record(raw) && record(raw.message));
      const records = readable.map(parse);
      if (records.some((item) => item.key.remoteJid !== input.remoteJid)) throw new Error('HISTORY_IDENTITY');
      return records.sort((a, b) => a.messageTimestamp - b.messageTimestamp || a.key.id.localeCompare(b.key.id));
    },
    async findMessage(input: { instanceName: string; id: string }): Promise<HistoryRecord | null> {
      if (!input.id) throw new Error('HISTORY_MESSAGE_ID');
      const data = await post(`/chat/findMessages/${encodeURIComponent(input.instanceName)}`, {
        where: { key: { id: input.id } }, page: 1, offset: 10
      });
      if (!record(data) || !record(data.messages) || !Array.isArray(data.messages.records)) throw new Error('HISTORY_SHAPE');
      const matches = data.messages.records.filter((item) => record(item) && record(item.key) && item.key.id === input.id);
      if (matches.length > 1) throw new Error('HISTORY_DUPLICATE_MESSAGE');
      return matches.length ? parse(matches[0]) : null;
    },
    async hasPriorMessages(input: { instanceName: string; remoteJid: string; excludeMessageId?: string | null; before?: Date }): Promise<boolean> {
      if (!direct(input.remoteJid)) throw new Error('HISTORY_IDENTITY');
      const beforeSeconds = input.before ? Math.floor(input.before.getTime() / 1000) : null;
      if (beforeSeconds !== null && !Number.isFinite(beforeSeconds)) throw new Error('HISTORY_WINDOW');
      const data = await post(`/chat/findMessages/${encodeURIComponent(input.instanceName)}`, {
        where: { key: { remoteJid: input.remoteJid } }, page: 1, offset: 100
      });
      if (!record(data) || !record(data.messages) || !Array.isArray(data.messages.records)) throw new Error('HISTORY_SHAPE');
      return data.messages.records.some((raw) => {
        if (!record(raw) || !record(raw.key) || typeof raw.key.id !== 'string' || !raw.key.id) return true;
        if (raw.key.id === (input.excludeMessageId ?? null)) return false;
        if (beforeSeconds === null) return true;
        const timestamp = Number(raw.messageTimestamp);
        if (raw.messageTimestamp === null || !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > 1e11) return true;
        return timestamp < beforeSeconds;
      });
    },
    async load(input: { instanceName: string; anchorId: string; from: Date; to: Date }): Promise<HistoryRecord[]> {
      if (!input.anchorId || !Number.isFinite(input.from.getTime()) || !Number.isFinite(input.to.getTime()) || input.from > input.to) throw new Error('HISTORY_WINDOW');
      const anchorPage = await page(input.instanceName, { id: input.anchorId }, 1);
      if (anchorPage.records.length !== 1 || !record(anchorPage.records[0]) || !record(anchorPage.records[0].key) || anchorPage.records[0].key.id !== input.anchorId) throw new Error('HISTORY_ANCHOR');
      const anchor = parse(anchorPage.records[0]);
      const identities = [...new Set([anchor.key.remoteJid, ...(anchor.key.remoteJidAlt ? [anchor.key.remoteJidAlt] : [])])];
      let previous: string | undefined;
      for (let pass = 0; pass < 3; pass++) {
        const records = new Map<string, HistoryRecord>();
        for (const jid of identities) {
          let pages = 1;
          for (let index = 1; index <= pages; index++) {
            const result = await page(input.instanceName, { remoteJid: jid }, index);
            pages = Math.max(pages, result.pages);
            for (const raw of result.records) {
              // A non-direct result is identity contamination, not a silently skipped group.
              if (!record(raw) || !record(raw.key) || !identities.includes(String(raw.key.remoteJid))) throw new Error('HISTORY_IDENTITY');
              const item = parse(raw);
              const ms = item.messageTimestamp * 1000;
              if (ms < input.from.getTime() || ms > input.to.getTime()) continue;
              const prior = records.get(item.key.id);
              if (prior && digest(prior) !== digest(item)) throw new Error('HISTORY_CONFLICT');
              records.set(item.key.id, item);
            }
          }
        }
        const sorted = [...records.values()].sort((a, b) => a.messageTimestamp - b.messageTimestamp || a.key.id.localeCompare(b.key.id));
        const current = digest(sorted);
        if (current === previous) return sorted;
        previous = current;
      }
      throw new Error('HISTORY_UNSTABLE');
    },
    async media(input: { instanceName: string; id: string }) {
      const data = await post(`/chat/getBase64FromMediaMessage/${encodeURIComponent(input.instanceName)}`, { message: { key: { id: input.id } }, convertToMp4: false });
      if (!record(data) || typeof data.base64 !== 'string' || typeof data.mimetype !== 'string') throw new Error('HISTORY_MEDIA_SHAPE');
      const mime = data.mimetype.split(';')[0].trim().toLowerCase();
      if (!/^(image\/(jpeg|png|webp)|audio\/(mpeg|mp3|mp4|m4a|x-m4a|wav|x-wav|ogg|opus|webm)|application\/pdf)$/.test(mime)) throw new Error('HISTORY_MEDIA_TYPE');
      const base64 = data.base64.replace(/^data:[^,]+,/, '').replace(/\s/g, '');
      if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || Buffer.from(base64, 'base64').length > 8 * 1024 * 1024) throw new Error('HISTORY_MEDIA_LIMIT');
      return `data:${mime};base64,${base64}`;
    }
  };
}
export type EvolutionHistorySource = ReturnType<typeof createEvolutionHistorySource>;
