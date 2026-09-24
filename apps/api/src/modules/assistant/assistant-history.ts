import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { EvolutionHistorySource } from '../evolution/evolution-history.js';
import { extractMessageContent } from '../evolution/evolution.routes.js';
import { AssistantError, lockAssistantConversation } from './assistant-access.js';
import { resolveConversationAssistant } from './assistant-policy.js';
import type { InboundMediaResult } from '../agents/inbound-media.js';

const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const zero = { inserted: 0, imported: 0, unreadMedia: 0, skipped: true };
export type HistoryMediaPreparer = (input: { workspaceId: string; mediaUrl: string; kind: 'image' | 'audio' | 'document' }) => Promise<InboundMediaResult>;

function unwrap(input: Record<string, unknown>) {
  let current = input;
  for (let n = 0; n < 4; n++) {
    const wrapper = ['ephemeralMessage', 'documentWithCaptionMessage', 'viewOnceMessage', 'viewOnceMessageV2'].find(k => object(current[k]).message);
    if (!wrapper) break;
    current = object(object(current[wrapper]).message);
  }
  return current;
}

/** Imports context only. No sender, scheduler, webhook dispatcher or conversation mutation dependency. */
export function createAssistantHistoryImporter(db: PrismaClient, source: EvolutionHistorySource, options: { prepareMedia?: HistoryMediaPreparer } = {}) {
  return async (workspaceId: string, conversationId: string, input: { force?: boolean; dryRun?: boolean } = {}) => {
    const conversation = await db.conversation.findFirst({ where: { workspaceId, id: conversationId }, include: { channel: true, activeAgentSession: true } });
    if (!conversation || conversation.channel.provider !== 'evolution' || !conversation.channel.providerKey) return zero;
    const {settings,humanSupport}=resolveConversationAssistant(conversation);
    if ((conversation.aiControlStatus !== 'agent_allowed' && !humanSupport) || settings.mode === 'disabled') return zero;
    if (!input.force && object(object(conversation.channel.encryptedConfig).assistantHistory).days !== 30) return zero;
    const live = await db.message.findMany({ where: { workspaceId, conversationId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 5001 });
    const anchor = live.find(m => m.providerMessageId && object(object(m.metadata).historyImport).source !== 'evolution');
    if (!anchor?.providerMessageId) throw new AssistantError('ASSISTANT_HISTORY_ANCHOR', 'Não foi possível identificar a origem do histórico.');
    if (object(object(anchor.metadata).assistantHistory).completed === true) return zero;
    const to = anchor.createdAt;
    const from = new Date(to.getTime() - 30 * 86400000);
    let records;
    try { records = await source.load({ instanceName: conversation.channel.providerKey, anchorId: anchor.providerMessageId, from, to }); }
    catch { throw new AssistantError('ASSISTANT_HISTORY_UNAVAILABLE', 'Não foi possível recuperar o histórico anterior. Tente novamente antes de usar a sugestão.'); }
    // Source scope/time are checked again here: alternate adapters cannot widen an import.
    if (records.some(r => r.messageTimestamp * 1000 < from.getTime() || r.messageTimestamp * 1000 > to.getTime())) throw new AssistantError('ASSISTANT_HISTORY_WINDOW', 'O histórico retornou mensagens fora do período.');
    const existing = await db.message.findMany({ where: { workspaceId, providerMessageId: { in: records.map(r => r.key.id) } } });
    if (existing.some(m => m.conversationId !== conversationId)) throw new AssistantError('ASSISTANT_HISTORY_CONFLICT', 'Um identificador do histórico pertence a outra conversa. Revise antes de importar.');
    const known = new Set(existing.map(m => m.providerMessageId));
    const missing = records.filter(r => !known.has(r.key.id));
    if (live.length + missing.length > 2000) throw new AssistantError('ASSISTANT_HISTORY_LIMIT', 'O histórico excede 2.000 mensagens. Revise o período antes de importar.');
    if (input.dryRun) return { ...zero, imported: records.length, missing: missing.length, from: from.toISOString(), to: to.toISOString(), media: missing.filter(r => ['image','audio','file'].includes(extractMessageContent(unwrap(r.message), r.messageType).type)).length };
    const batchId = randomUUID();
    let unreadMedia = 0;
    let mediaBytes = 0;
    const startedAt = Date.now();
    const rows: Prisma.MessageCreateManyInput[] = [];
    for (const item of missing) {
      const content = extractMessageContent(unwrap(item.message), item.messageType);
      const id = randomUUID();
      const date = new Date(item.messageTimestamp * 1000);
      const provenance: Record<string, unknown> = { source: 'evolution', batchId, from: from.toISOString(), to: to.toISOString(), originalType: item.messageType ?? Object.keys(item.message)[0] ?? 'unknown' };
      const metadata: Record<string, unknown> = { historyImport: provenance };
      let mediaUrl: string | null = null;
      if (['image', 'audio', 'file'].includes(content.type)) {
        try {
          // Bound memory and first-reply latency; remaining media stays visibly unread.
          if (mediaBytes >= 32 * 1024 * 1024 || Date.now() - startedAt > 240000) throw new Error('HISTORY_MEDIA_BUDGET');
          mediaUrl = await source.media({ instanceName: conversation.channel.providerKey, id: item.key.id });
          mediaBytes += Buffer.byteLength(mediaUrl, 'utf8');
          if (mediaBytes > 32 * 1024 * 1024) { mediaUrl = null; throw new Error('HISTORY_MEDIA_BUDGET'); }
          provenance.mediaStatus = 'recovered';
          if (options.prepareMedia) {
            const result = await options.prepareMedia({ workspaceId, mediaUrl, kind: content.type === 'file' ? 'document' : content.type as 'image' | 'audio' });
            if (result.status === 'processed') {
              metadata.assistantMedia = { sourceHash: hash([id, content.type, mediaUrl]), result };
              provenance.mediaStatus = 'processed';
            } else { provenance.mediaStatus = 'unread'; unreadMedia++; }
          } else { unreadMedia++; }
        } catch { provenance.mediaStatus = 'unavailable'; unreadMedia++; }
      }
      rows.push({ id, workspaceId, conversationId, providerMessageId: item.key.id,
        providerEventId: `history:${conversation.channel.providerKey}:${item.key.id}`,
        direction: item.key.fromMe ? 'outbound' : 'inbound', status: item.key.fromMe ? 'sent' : 'delivered',
        type: content.type, body: content.body ?? `[Mensagem histórica ${provenance.originalType}: conteúdo não interpretado]`,
        mediaUrl, metadata: JSON.parse(JSON.stringify(metadata)), createdAt: date, ingestedAt: date });
    }
    return db.$transaction(async tx => {
      await lockAssistantConversation(tx, workspaceId, conversationId);
      const current = await tx.message.findFirst({ where: { workspaceId, conversationId, id: anchor.id } });
      if (!current) throw new AssistantError('ASSISTANT_HISTORY_CHANGED', 'A conversa mudou durante a importação.');
      if (object(object(current.metadata).assistantHistory).completed === true) return zero;
      const collisions = await tx.message.findMany({ where: { workspaceId, providerMessageId: { in: rows.map(r => r.providerMessageId!) } } });
      if (collisions.some(m => m.conversationId !== conversationId)) throw new AssistantError('ASSISTANT_HISTORY_CONFLICT', 'Um identificador do histórico pertence a outra conversa.');
      const inserted = rows.length ? await tx.message.createMany({ data: rows, skipDuplicates: true }) : { count: 0 };
      const completion = { completed: true, version: 1, days: 30, batchId, from: from.toISOString(), to: to.toISOString(), sourceRecords: records.length, inserted: inserted.count, unreadMedia, at: new Date().toISOString() };
      const marked = await tx.message.updateMany({ where: { id: current.id, workspaceId, metadata: { equals: current.metadata as Prisma.InputJsonValue } },
        data: { metadata: { ...object(current.metadata), assistantHistory: completion } as Prisma.InputJsonValue } });
      if (marked.count !== 1) throw new AssistantError('ASSISTANT_HISTORY_CHANGED', 'A conversa mudou durante a importação.');
      return { inserted: inserted.count, imported: records.length, unreadMedia, skipped: false };
    }, { timeout: 15000 });
  };
}
