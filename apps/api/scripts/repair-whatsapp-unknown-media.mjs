import { PrismaClient } from '@prisma/client';

// Run without --apply to inspect counts first. Only messages confirmed by Evolution are changed.
const apply = process.argv.includes('--apply');
const db = new PrismaClient();
const counts = { checked: 0, sticker: 0, reaction: 0, contact: 0, protected: 0, other: 0, unavailable: 0, updated: 0 };
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function unwrap(value) {
  let message = record(value);
  for (let depth = 0; depth < 6; depth++) {
    const inner = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage']
      .map(key => record(message[key]).message).find(value => Object.keys(record(value)).length > 0);
    if (!inner) break;
    message = record(inner);
  }
  return message;
}

function classify(item) {
  const message = unwrap(item.message);
  const kind = item.messageType;
  if (message.stickerMessage || kind === 'stickerMessage') return { kind: 'sticker', type: 'image', body: 'Figurinha recebida' };
  if (message.reactionMessage || kind === 'reactionMessage') {
    const emoji = record(message.reactionMessage).text;
    return { kind: 'reaction', type: 'system', body: typeof emoji === 'string' && emoji ? `Reagiu com ${emoji}` : 'Removeu uma reação' };
  }
  if (message.contactMessage || message.contactsArrayMessage || kind === 'contactMessage' || kind === 'contactsArrayMessage')
    return { kind: 'contact', type: 'text', body: 'Contato recebido' };
  if (message.secretEncryptedMessage || kind === 'secretEncryptedMessage')
    return { kind: 'protected', type: 'system', body: 'Mensagem protegida pelo WhatsApp' };
  return null;
}

async function inspect(message) {
  counts.checked++;
  const instance = message.conversation.channel.providerKey;
  if (message.conversation.channel.provider !== 'evolution' || !instance) { counts.other++; return; }
  let source;
  try {
    const response = await fetch(`${process.env.EVOLUTION_API_BASE_URL.replace(/\/$/, '')}/chat/findMessages/${encodeURIComponent(instance)}`, {
      method: 'POST', headers: { apikey: process.env.EVOLUTION_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ where: { key: { id: message.providerMessageId } }, page: 1, offset: 2 }),
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) throw new Error('provider unavailable');
    const data = await response.json();
    const records = record(data.messages).records;
    if (!Array.isArray(records)) throw new Error('provider shape');
    source = records.find(item => record(item.key).id === message.providerMessageId);
  } catch { counts.unavailable++; return; }
  if (!source) { counts.unavailable++; return; }
  const result = classify(source);
  if (!result) { counts.other++; return; }
  counts[result.kind]++;
  if (!apply) return;
  const updated = await db.message.updateMany({
    where: { id: message.id, workspaceId: message.workspaceId, type: 'text', body: null },
    data: { type: result.type, body: result.body }
  });
  counts.updated += updated.count;
  if (updated.count) await db.conversation.updateMany({
    where: { id: message.conversationId, workspaceId: message.workspaceId,
      lastMessageAt: message.createdAt, lastMessagePreview: 'Mensagem recebida' },
    data: { lastMessagePreview: result.body }
  });
}

try {
  if (!process.env.EVOLUTION_API_BASE_URL || !process.env.EVOLUTION_API_KEY) throw new Error('Evolution is not configured');
  const messages = await db.message.findMany({
    where: { type: 'text', body: null, providerMessageId: { not: null } },
    orderBy: { createdAt: 'desc' }, take: 2000,
    select: { id: true, workspaceId: true, conversationId: true, providerMessageId: true, createdAt: true,
      conversation: { select: { channel: { select: { provider: true, providerKey: true } } } } }
  });
  for (let index = 0; index < messages.length; index += 6)
    await Promise.all(messages.slice(index, index + 6).map(inspect));
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...counts }));
} finally { await db.$disconnect(); }
