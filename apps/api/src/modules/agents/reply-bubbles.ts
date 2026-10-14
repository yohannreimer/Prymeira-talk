/**
 * Splits an agent reply into the separate WhatsApp messages a person would
 * send: one bubble per paragraph (blank line), at most `max` bubbles. Extra
 * paragraphs stay together in the last bubble so nothing is dropped.
 */
export function splitReplyIntoBubbles(reply: string, max = 3): string[] {
  const parts = reply.split(/\n[ \t]*\n/).map((part) => part.trim()).filter(Boolean);
  if (parts.length <= max) return parts.length > 0 ? parts : [reply.trim()].filter(Boolean);
  return [...parts.slice(0, max - 1), parts.slice(max - 1).join("\n\n")];
}

/** How long WhatsApp shows "digitando..." before a bubble: longer text, longer typing. */
export function typingDelayMs(text: string) {
  return Math.min(4_000, Math.max(1_200, 900 + text.length * 30));
}
