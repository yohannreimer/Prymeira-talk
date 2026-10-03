import { lastMessageKind, type MessageDto } from '@prymeira-talk/shared';
import { mediaKindLabels, mediaPlaceholders, type MediaKind } from './ConversationPreview';
import { mediaCaption, mediaFileName } from './InboxMedia';

export type ReactionChip = { emoji: string; count: number; mine: boolean };

/**
 * WhatsApp shows reactions on the message they react to, not as messages: one current emoji per person (the latest
 * wins, an empty one removes it). Returns the messages to draw and, per WhatsApp id, the reaction chips to draw on it.
 * A reaction whose message is not loaded is simply not drawn.
 */
export function threadWithReactions(messages: MessageDto[]) {
  const byTarget = new Map<string, Map<string, string | null>>();
  const visible: MessageDto[] = [];
  for (const message of messages) {
    if (!message.reaction) { visible.push(message); continue; }
    const sender = message.direction === 'outbound' ? 'me' : message.senderJid ?? 'contact';
    const reactions = byTarget.get(message.reaction.targetWhatsappId) ?? new Map<string, string | null>();
    reactions.set(sender, message.reaction.emoji);
    byTarget.set(message.reaction.targetWhatsappId, reactions);
  }
  const chips = new Map<string, ReactionChip[]>();
  for (const [target, reactions] of byTarget) {
    const counts = new Map<string, ReactionChip>();
    for (const [sender, emoji] of reactions) {
      if (!emoji) continue;
      const chip = counts.get(emoji) ?? { emoji, count: 0, mine: false };
      chip.count++; chip.mine ||= sender === 'me';
      counts.set(emoji, chip);
    }
    if (counts.size) chips.set(target, [...counts.values()]);
  }
  return { visible, chips };
}

/** Who and what a reply quotes: the loaded message when there is one, otherwise what WhatsApp sent along. */
export function quotedPreview(quoted: NonNullable<MessageDto['quoted']>, messages: MessageDto[], contactName: string | null) {
  const target = messages.find(message => message.whatsappId === quoted.whatsappId);
  const author = target ? target.direction === 'outbound' ? 'Você' : target.senderName?.trim() || contactName || 'Contato'
    : quoted.participant ? quoted.participant.split('@')[0]! : contactName || 'Contato';
  const declared = target ? lastMessageKind({ type: target.type, body: target.body, mimeType: target.attachment?.mimeType, mediaUrl: target.mediaUrl }) : null;
  const raw = quoted.body?.trim() || target?.body?.trim() || '';
  const kind: MediaKind | null = declared && declared !== 'text' ? declared : mediaPlaceholders[raw] ?? null;
  // Like WhatsApp: a quoted attachment reads as its kind (or its caption / file name), never "Figurinha recebida".
  const text = !kind ? raw || 'Mensagem'
    : kind === 'file' && target ? mediaFileName(target)
    : (target && mediaCaption(target)) || (mediaPlaceholders[raw] ? mediaKindLabels[kind] : raw || mediaKindLabels[kind]);
  return { author, text, targetId: target?.id ?? null, target: target ?? null, kind };
}
