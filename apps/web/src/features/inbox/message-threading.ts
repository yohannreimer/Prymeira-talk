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
  const ballots = new Map<string, Map<string, string[] | null>>();
  const visible: MessageDto[] = [];
  for (const message of messages) {
    const sender = message.direction === 'outbound' ? 'me' : message.senderJid ?? 'contact';
    // Poll votes count on their poll (one current vote per person), never as messages.
    if (message.pollVote) {
      const votes = ballots.get(message.pollVote.targetWhatsappId) ?? new Map<string, string[] | null>();
      votes.set(sender, message.pollVote.options ?? votes.get(sender) ?? null);
      ballots.set(message.pollVote.targetWhatsappId, votes);
      continue;
    }
    if (!message.reaction) { visible.push(message); continue; }
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
  const polls = new Map<string, PollTally>();
  for (const [target, votes] of ballots) {
    const tally: PollTally = { voters: votes.size, options: new Map() };
    for (const [sender, options] of votes) for (const option of options ?? []) {
      const entry = tally.options.get(option) ?? { count: 0, mine: false };
      entry.count++; entry.mine ||= sender === 'me';
      tally.options.set(option, entry);
    }
    polls.set(target, tally);
  }
  return { visible, chips, polls };
}

/** Votes on one poll: how many people voted and, per option, how many picked it (votes WhatsApp kept encrypted count
 * as voters only). */
export type PollTally = { voters: number; options: Map<string, { count: number; mine: boolean }> };

/** A poll as Talk stores it ("📊 Enquete: name" then one "○ option" per line), or null for any other text. */
export function parsePoll(body: string | null | undefined) {
  const lines = (body ?? '').split('\n');
  const title = /^📊 Enquete: (.*)$/u.exec(lines[0] ?? '')?.[1];
  if (title === undefined) return null;
  const options = lines.slice(1).map(line => /^○ (.+)$/u.exec(line)?.[1]).filter((option): option is string => Boolean(option));
  return options.length ? { title, options } : null;
}

/** A shared Pix key as Talk stores it ("💠 Chave Pix", merchant, amount, "Tipo: chave"): the key to copy. */
export function parsePixKey(body: string | null | undefined) {
  const lines = (body ?? '').split('\n');
  const at = lines.indexOf('💠 Chave Pix');
  if (at < 0) return null;
  const key = /^[^:]+: (.+)$/.exec(lines[lines.length - 1] ?? '')?.[1]?.trim();
  return key && lines.length - 1 > at ? key : null;
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

/** Who the group's "@123…" mentions are: WhatsApp writes a mention as the person's number or hidden id, and draws
 * their name. Built from the names Talk already knows for the senders in this conversation. */
export function mentionNames(messages: MessageDto[]) {
  const names = new Map<string, string>();
  for (const message of messages) {
    const id = message.senderJid?.split('@')[0], name = message.senderName?.trim();
    if (id && name && !/^\+?\d+$/.test(name)) names.set(id, name);
  }
  return names;
}
export function withMentionNames(text: string, names: Map<string, string>) {
  return names.size ? text.replace(/@(\d{6,20})\b/g, (mention, id: string) => names.has(id) ? `@${names.get(id)}` : mention) : text;
}
