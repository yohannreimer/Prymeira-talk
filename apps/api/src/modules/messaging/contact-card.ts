export function parseContactCard(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const card = value as Record<string, unknown>;
  const vcard = typeof card.vcard === 'string' ? card.vcard.slice(0, 32_000).replace(/\r?\n[ \t]/g, '') : '';
  const fullName = (typeof card.displayName === 'string' ? card.displayName : '')
    .trim() || /^FN:(.+)$/im.exec(vcard)?.[1]?.trim() || 'Contato';
  // WhatsApp writes the phone as "item1.TEL;waid=...:+55 ..." (a vCard group prefix).
  const tel = vcard.split(/\r?\n/).find(line => /^(?:[\w-]+\.)?TEL(?:;|:)/i.test(line));
  const waid = tel && /(?:^|;)waid=(\d+)/i.exec(tel)?.[1];
  const phoneNumber = (waid || tel?.slice(tel.indexOf(':') + 1).replace(/\D/g, '') || '').slice(0, 20) || null;
  return { fullName: fullName.slice(0, 200), phoneNumber };
}
