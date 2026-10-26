export function parseAddress(raw: string | null): string | null {
  if (!raw || raw.length > 150) return null;
  let value = raw.trim();
  try { const parsed: unknown = JSON.parse(value); if (typeof parsed === 'string') value = parsed; } catch { /* native unquoted address */ }
  value = value.replace(/^(\d+):\d+@(c\.us|s\.whatsapp\.net|lid)$/, '$1@$2');
  if (/^\d{8,15}@(c\.us|s\.whatsapp\.net)$/.test(value)) return value.replace('@c.us', '@s.whatsapp.net');
  if (/^\d{1,30}@lid$/.test(value) || /^\d+(?:-\d+)?@g\.us$/.test(value)) return value;
  return null;
}
export function messagePeer(raw: string | null): string | null {
  const peer = raw && /^(?:true|false)_([^_]+)_.+$/.exec(raw)?.[1];
  return parseAddress(peer || null);
}
export function canonicalPhone(address: string): string {
  const digits = address.split('@')[0]!.replace(/\D/g, '');
  return digits.startsWith('55') && digits.length === 13 && digits[4] === '9' ? digits.slice(0, 4) + digits.slice(5) : digits;
}
export function ownAddress(storage: Pick<Storage, 'getItem'>): string | null {
  try {
    const candidates = ['last-wid-md', 'last-wid'].map(k => parseAddress(storage.getItem(k)))
      .filter((v): v is string => !!v?.endsWith('@s.whatsapp.net'));
    return new Set(candidates.map(canonicalPhone)).size === 1 ? candidates[0]! : null;
  } catch { return null; }
}
