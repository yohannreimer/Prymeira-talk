import { createHash } from 'node:crypto';

export type HistoryRecord = {
  key: { id: string; remoteJid: string; remoteJidAlt?: string; fromMe: boolean };
  messageTimestamp: number;
  message: Record<string, unknown>;
  messageType?: string;
};
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const direct = (s: unknown): s is string => typeof s === 'string' && /^\d+@(s\.whatsapp\.net|lid)$/.test(s);
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
      ...(typeof value.messageType === 'string' ? { messageType: value.messageType } : {}) };
  }
  return {
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
