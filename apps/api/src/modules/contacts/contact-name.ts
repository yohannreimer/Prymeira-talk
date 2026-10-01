const MAX_NAME_LENGTH = 200;
// Labels WhatsApp/Evolution use for "this side" or for a missing name. They are
// only rejected when they are the whole name, never as a word of a longer name.
const PLACEHOLDERS = new Set(['voce', 'vc', 'you', 'eu', 'me', 'meu', 'ninguem', 'unknown', 'desconhecido', 'null', 'undefined']);
const WHATSAPP_ID = /@(lid|s\.whatsapp\.net|c\.us|g\.us)\b/i;

/** Returns a name safe to store as a contact's name, or null when the value is not a real name. */
export function usableContactName(raw: string | null | undefined): string | null {
  const name = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  if (WHATSAPP_ID.test(name) || /^\d+@lid$/i.test(name)) return null;
  if (/^\d{7,}$/.test(name.replace(/[+\s\-().]/g, ''))) return null;
  const folded = name.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (PLACEHOLDERS.has(folded)) return null;
  const codePoints = Array.from(name);
  return codePoints.length > MAX_NAME_LENGTH ? codePoints.slice(0, MAX_NAME_LENGTH).join('').trimEnd() : name;
}
