import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { EvolutionHistorySource, HistoryRecord, RecentEvolutionChat } from '../evolution/evolution-history.js';
import { attachmentPresentation, extractMessageContent } from '../evolution/evolution.routes.js';
import { buildPhoneLookupCandidates, normalizePhoneForStorage } from '../contacts/phone-normalization.js';

type ImportChannel = { id: string; workspaceId: string; providerKey: string; historyImportAttempts: number };
const lid = (value: string) => /^\d+@lid$/.test(value);
const contactIdentity = (jid: string) => lid(jid) ? jid : normalizePhoneForStorage(jid.split('@')[0]);

function preview(record: HistoryRecord) {
  return extractMessageContent(record.message, record.messageType).preview;
}

/** Writes historical context directly; it never invokes message automations or increments unread counts. */
export function createChannelHistoryImporter(input: {
  prisma: PrismaClient;
  source: EvolutionHistorySource;
  onConversation?: (workspaceId: string, conversationId: string) => Promise<void> | void;
}) {
  async function importChat(channel: ImportChannel, chat: RecentEvolutionChat, limit = 30, since?: Date) {
    const phone = contactIdentity(chat.phoneJid);
    if (!lid(phone) && (!phone || phone.length < 8 || phone.length > 15)) return 0;
    const records = await input.source.recentMessages({ instanceName: channel.providerKey, remoteJid: chat.remoteJid, limit });
    if (!records.length) return 0;
    if (since && records.at(-1)!.messageTimestamp * 1000 < since.getTime()) return 0;
    const name = chat.pushName ?? [...records].reverse().find((record) => !record.key.fromMe && record.pushName)?.pushName ?? null;
    const result = await input.prisma.$transaction(async (tx) => {
      const candidates = lid(phone) ? [phone] : buildPhoneLookupCandidates(phone);
      const contact = await tx.contact.findFirst({ where: { workspaceId: channel.workspaceId, phone: { in: candidates } }, orderBy: { updatedAt: 'desc' } })
        ?? (chat.remoteJid.endsWith('@lid') && !lid(phone)
          ? await tx.contact.findFirst({ where: { workspaceId: channel.workspaceId, OR: [
              { phone: chat.remoteJid }, { customFields: { path: ['evolutionLid'], equals: chat.remoteJid } }
            ] } }) : null)
        ?? await tx.contact.upsert({ where: { workspaceId_phone: { workspaceId: channel.workspaceId, phone } },
          create: { workspaceId: channel.workspaceId, phone, name, avatarUrl: chat.profilePicUrl }, update: {} });
      const contactPatch = {
        ...(name && !contact.name ? { name } : {}),
        ...(chat.profilePicUrl && !contact.avatarUrl ? { avatarUrl: chat.profilePicUrl } : {})
      };
      if (Object.keys(contactPatch).length) {
        await tx.contact.updateMany({ where: { workspaceId: channel.workspaceId, id: contact.id }, data: contactPatch });
      }
      const conversation = await tx.conversation.upsert({
        where: { workspaceId_channelId_contactId: { workspaceId: channel.workspaceId, channelId: channel.id, contactId: contact.id } },
        create: { workspaceId: channel.workspaceId, channelId: channel.id, contactId: contact.id, status: 'open',
          aiControlStatus: 'human_controlled', unreadCount: 0 }, update: {}
      });
      const ids = [...new Set(records.map((record) => record.key.id))];
      const existing = await tx.message.findMany({ where: { workspaceId: channel.workspaceId, providerMessageId: { in: ids } }, select: { providerMessageId: true, conversationId: true } });
      const known = new Set(existing.map((message) => message.providerMessageId));
      const foreign = new Set(existing.filter((message) => message.conversationId !== conversation.id).map((message) => message.providerMessageId));
      const rows: Prisma.MessageCreateManyInput[] = [];
      for (const record of records) {
        if (known.has(record.key.id)) continue;
        known.add(record.key.id);
        const content = extractMessageContent(record.message, record.messageType);
        const date = new Date(record.messageTimestamp * 1000);
        rows.push({ id: randomUUID(), workspaceId: channel.workspaceId, conversationId: conversation.id,
          providerMessageId: record.key.id,
          providerEventId: `history:${channel.providerKey}:${record.key.id}`,
          direction: record.key.fromMe ? 'outbound' : 'inbound', type: content.type,
          body: content.body, mediaUrl: content.mediaUrl,
          status: record.key.fromMe ? 'sent' : 'delivered',
          metadata: { historyImport: { source: 'evolution', channelId: channel.id, originalType: record.messageType ?? null },
            ...(['audio', 'image', 'file'].includes(content.type) ? { attachment: attachmentPresentation(record.message) } : {}),
            ...(content.contactCards?.length ? { contactCards: content.contactCards } : {}) },
          createdAt: date, ingestedAt: date });
      }
      const inserted = rows.length ? await tx.message.createMany({ data: rows, skipDuplicates: true }) : { count: 0 };
      const newest = records.filter((record) => !foreign.has(record.key.id)).at(-1);
      if (newest) {
        const newestAt = new Date(newest.messageTimestamp * 1000);
        await tx.conversation.updateMany({ where: { id: conversation.id, workspaceId: channel.workspaceId,
          OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: newestAt } }] },
          data: { lastMessageAt: newestAt, lastMessagePreview: preview(newest) } });
      }
      return { conversationId: conversation.id, inserted: inserted.count };
    }, { timeout: 60_000 });
    await input.onConversation?.(channel.workspaceId, result.conversationId);
    return result.inserted;
  }

  async function importContacts(channel: ImportChannel, chats: RecentEvolutionChat[] = []) {
    const source = await input.source.recentContacts({ instanceName: channel.providerKey });
    const contacts = new Map<string, { name: string | null; avatarUrl: string | null }>();
    for (const item of [...chats.map((chat) => ({ phoneJid: chat.phoneJid, name: chat.pushName, profilePicUrl: chat.profilePicUrl })), ...source]) {
      const phone = contactIdentity(item.phoneJid);
      if (!lid(phone) && (phone.length < 8 || phone.length > 15)) continue;
      const previous = contacts.get(phone);
      contacts.set(phone, {
        name: item.name ?? previous?.name ?? null,
        avatarUrl: item.profilePicUrl ?? previous?.avatarUrl ?? null
      });
    }
    if (!contacts.size) return contacts;
    const candidates = [...new Set([...contacts.keys()].flatMap((identity) => lid(identity) ? [identity] : buildPhoneLookupCandidates(identity)))];
    const existing = await input.prisma.contact.findMany({
      where: { workspaceId: channel.workspaceId, phone: { in: candidates } },
      select: { id: true, phone: true, name: true, avatarUrl: true }
    });
    const known = new Map(existing.map((contact) => [lid(contact.phone) ? contact.phone : normalizePhoneForStorage(contact.phone), contact]));
    const missing = [...contacts].filter(([phone]) => !known.has(phone));
    if (missing.length) {
      await input.prisma.contact.createMany({ data: missing.map(([phone, details]) => ({
        workspaceId: channel.workspaceId, phone, name: details.name, avatarUrl: details.avatarUrl
      })), skipDuplicates: true });
    }
    for (const [phone, details] of contacts) {
      const contact = known.get(phone);
      if (!contact) continue;
      if (details.name && !contact.name) {
        await input.prisma.contact.updateMany({ where: { id: contact.id, workspaceId: channel.workspaceId, name: null }, data: { name: details.name } });
      }
      if (details.avatarUrl && !contact.avatarUrl) {
        await input.prisma.contact.updateMany({ where: { id: contact.id, workspaceId: channel.workspaceId, avatarUrl: null }, data: { avatarUrl: details.avatarUrl } });
      }
    }
    return contacts;
  }

  const importChannel = async (channel: ImportChannel, shouldStop: () => boolean = () => false) => {
    const all = await input.source.recentChats({ instanceName: channel.providerKey, limit: 1000 });
    const contacts = await importContacts(channel, all.chats);
    const since = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    const { chats } = await input.source.recentChats({ instanceName: channel.providerKey, limit: 1000, since });
    if (!chats.length) {
      if (!contacts.size || channel.historyImportAttempts < 3) throw new Error('HISTORY_CHATS_NOT_READY');
      return { conversations: 0, messages: 0 };
    }
    let inserted = 0;
    for (const chat of chats) {
      if (shouldStop()) throw new Error('HISTORY_IMPORT_STOPPED');
      chat.pushName = contacts.get(contactIdentity(chat.phoneJid))?.name ?? chat.pushName;
      inserted += await importChat(channel, chat, 30, since);
    }
    if (inserted === 0) {
      // The chat list can arrive before Evolution finishes synchronizing messages.
      const total = await input.prisma.message.count({ where: { workspaceId: channel.workspaceId, conversation: { channelId: channel.id } } });
      if (total === 0) throw new Error('HISTORY_MESSAGES_NOT_READY');
    }
    // A connected instance can expose all chats long before their messages finish syncing.
    // Revisit the available chats until at least four passes and one pass adds no messages.
    if (channel.historyImportAttempts < 3 || inserted > 0) throw new Error('HISTORY_CHATS_SETTLING');
    return { conversations: chats.length, messages: inserted };
  };
  return Object.assign(importChannel, { importChat });
}

export function createChannelHistoryImportScheduler(input: {
  prisma: PrismaClient;
  source: EvolutionHistorySource;
  onConversation?: (workspaceId: string, conversationId: string) => Promise<void> | void;
  onError?: (error: unknown, channelId?: string) => void;
  onComplete?: (channelId: string, conversations: number, messages: number) => void;
  pollIntervalMs?: number;
}) {
  const importChannel = createChannelHistoryImporter(input);
  let timer: NodeJS.Timeout | null = null;
  let active: Promise<void> | null = null;
  let stopping = false;

  async function tick() {
    if (stopping) return;
    const now = new Date();
    const due = await input.prisma.channel.findMany({ where: {
      provider: 'evolution', status: 'connected', historyImportStatus: 'pending', historyImportNextAt: { lte: now },
      OR: [{ historyImportLeaseUntil: null }, { historyImportLeaseUntil: { lt: now } }]
    }, orderBy: { historyImportNextAt: 'asc' }, take: 1 });
    for (const channel of due) {
      const token = randomUUID();
      const claimed = await input.prisma.channel.updateMany({ where: { id: channel.id, historyImportStatus: 'pending',
        historyImportNextAt: { lte: now }, OR: [{ historyImportLeaseUntil: null }, { historyImportLeaseUntil: { lt: now } }] },
        data: { historyImportLeaseToken: token, historyImportLeaseUntil: new Date(now.getTime() + 30 * 60_000) } });
      if (claimed.count !== 1) continue;
      try {
        const result = await importChannel(channel, () => stopping);
        await input.prisma.channel.updateMany({ where: { id: channel.id, historyImportLeaseToken: token }, data: {
          historyImportStatus: 'completed', historyImportCompletedAt: new Date(), historyImportNextAt: null,
          historyImportLeaseToken: null, historyImportLeaseUntil: null
        } });
        input.onComplete?.(channel.id, result.conversations, result.messages);
      } catch (error) {
        const expected = error instanceof Error && ['HISTORY_IMPORT_STOPPED', 'HISTORY_CHATS_NOT_READY', 'HISTORY_MESSAGES_NOT_READY', 'HISTORY_CHATS_SETTLING', 'HISTORY_LID_UNRESOLVED'].includes(error.message);
        if (!expected) input.onError?.(error, channel.id);
        const attempts = channel.historyImportAttempts + 1;
        await input.prisma.channel.updateMany({ where: { id: channel.id, historyImportLeaseToken: token }, data: {
          historyImportAttempts: { increment: stopping ? 0 : 1 },
          historyImportNextAt: new Date(Date.now() + (stopping ? 10_000 : Math.min(10 * 60_000, 30_000 * 2 ** Math.min(attempts, 4)))),
          historyImportLeaseToken: null, historyImportLeaseUntil: null
        } });
      }
    }
  }
  function poll() {
    if (active) return;
    active = tick().catch((error) => { input.onError?.(error); }).finally(() => { active = null; });
  }
  return {
    start() { if (timer) return; stopping = false; poll(); timer = setInterval(poll, input.pollIntervalMs ?? 10_000); timer.unref?.(); },
    async stop() { stopping = true; if (timer) clearInterval(timer); timer = null; await active; },
    runOnce: tick
  };
}
