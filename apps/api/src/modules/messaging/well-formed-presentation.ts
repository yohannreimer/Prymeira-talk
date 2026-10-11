import type { NormalizedMessagingEvent } from './normalized-event.js';

/** PostgreSQL text/JSON and Prisma require valid Unicode. In Unicode regexp mode,
 * valid surrogate pairs are one code point and do not match the surrogate range.
 * U+0000 is also unrepresentable in PostgreSQL text/JSONB. Keep raw receipts intact.
 */
export function wellFormedText<T extends string | null | undefined>(text: T): T {
  return (typeof text === 'string' ? text.replace(/[\u0000\uD800-\uDFFF]/gu, '\uFFFD') : text) as T;
}

/** Repair display text only: never rewrite source authority, message keys, target
 * IDs, phone numbers, addresses, URLs, timestamps or receipt/deduplication keys.
 */
export function wellFormedPresentation<T extends NormalizedMessagingEvent>(event: T): T {
  if (event.kind === 'edit') return { ...event, patch: event.patch.field === 'body'
    ? { ...event.patch, body: wellFormedText(event.patch.body) }
    : { ...event.patch, caption: wellFormedText(event.patch.caption) } } as T;
  if (event.kind !== 'message') return event;
  const content = event.content;
  return { ...event, pushName: wellFormedText(event.pushName), content: {
    ...content, body: wellFormedText(content.body), preview: wellFormedText(content.preview),
    ...(content.quoted ? { quoted: { ...content.quoted, body: wellFormedText(content.quoted.body) } } : {}),
    ...(content.reaction ? { reaction: { ...content.reaction, emoji: wellFormedText(content.reaction.emoji) } } : {}),
    ...(content.pollVote ? { pollVote: { ...content.pollVote, options: content.pollVote.options?.map(wellFormedText) ?? null } } : {}),
    ...(content.contactCards ? { contactCards: content.contactCards.map(card => ({ ...card, fullName: wellFormedText(card.fullName) })) } : {}),
    ...(content.location ? { location: { ...content.location, name: wellFormedText(content.location.name), address: wellFormedText(content.location.address) } } : {})
  }, attachment: { ...event.attachment,
    ...(event.attachment.fileName !== undefined ? { fileName: wellFormedText(event.attachment.fileName) } : {}),
    ...(event.attachment.caption !== undefined ? { caption: wellFormedText(event.attachment.caption) } : {}) } } as T;
}
