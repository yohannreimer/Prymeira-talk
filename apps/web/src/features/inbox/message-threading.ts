import type { MessageDto } from '@prymeira-talk/shared';

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
  const text = quoted.body?.trim() || target?.body?.trim() || 'Mensagem';
  return { author, text, targetId: target?.id ?? null };
}
