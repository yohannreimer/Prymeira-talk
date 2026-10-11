import type { MessageDto } from '@prymeira-talk/shared';
import type { TalkAlert } from '../../app/session/talk-session';

export type AlertNotice = { conversationId: string; title: string; body: string };

/** A handoff whose conversation was not loaded is only news when the customer wrote moments ago. */
const UNKNOWN_HANDOFF_WINDOW_MS = 10 * 60_000;

function preview(message: MessageDto) {
  const text = (message.body ?? message.attachment?.caption ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text.length > 120 ? `${text.slice(0, 117)}…` : text;
  if (message.location) return '📍 Localização';
  if (message.contactCards?.length) return '👤 Contato';
  if (message.type === 'image') return '📷 Foto';
  if (message.type === 'audio') return '🎤 Áudio';
  if (message.type === 'file') return message.attachment?.mimeType?.startsWith('video/') ? '🎥 Vídeo' : '📎 Arquivo';
  return 'Nova mensagem';
}

/**
 * Decides whether an alert is worth a sound. Each seller works in a workspace with
 * their own numbers, so every customer conversation there is theirs; a conversation
 * the AI is handling stays quiet until the AI hands it over.
 */
export function describeAlert(alert: TalkAlert, now = Date.now()): AlertNotice | null {
  const conversation = alert.conversation;
  if (conversation?.isGroup) return null;
  if (alert.kind === 'message') {
    const aiHandling = conversation?.aiControlStatus !== 'human_controlled' && conversation?.activeAgentSessionStatus === 'active';
    if (aiHandling) return null;
    const name = conversation?.contactName || alert.message.senderName || conversation?.contactPhone || 'Nova mensagem no WhatsApp';
    return { conversationId: alert.message.conversationId, title: name, body: preview(alert.message) };
  }
  if (!alert.previous) {
    const last = alert.conversation.lastMessageAt ? Date.parse(alert.conversation.lastMessageAt) : NaN;
    if (!(now - last <= UNKNOWN_HANDOFF_WINDOW_MS)) return null;
  }
  const name = alert.conversation.contactName || alert.conversation.contactPhone || 'Cliente';
  const reason = alert.conversation.handoffReason?.trim();
  return {
    conversationId: alert.conversation.id,
    title: `A IA passou ${name} para a equipe`,
    body: reason ? reason : 'O cliente está esperando um vendedor.'
  };
}

export function titleWithCount(base: string, count: number) {
  return count > 0 ? `(${count > 99 ? '99+' : count}) ${base}` : base;
}
