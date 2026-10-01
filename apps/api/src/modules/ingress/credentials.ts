/** Only envelope credential fields are removed. Message text is never rewritten.
 * Key/IV/media bytes remain only in the private object, not database or Rabbit. */
const credentialKey = /^(?:x[-_])?(?:api[-_]?key|credentials|prymeira[-_]talk[-_]secret|access[-_]?token|refresh[-_]?token|authorization|password|app[-_]?secret|webhook[-_]?secret|secret|token)$/i;
export function stripEnvelopeCredentials(value: unknown, field = ""): unknown {
  if (Array.isArray(value)) return value.map(entry => stripEnvelopeCredentials(entry, field));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !credentialKey.test(key))
    .map(([key, entry]) => [key, stripEnvelopeCredentials(entry, key)]));
  if (typeof value === 'string' && /url$/i.test(field) && /^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const sensitive = url.username || url.password || [...url.searchParams.keys()].some(key => credentialKey.test(key));
      if (!sensitive) return value;
      url.username = ''; url.password = '';
      for (const key of [...url.searchParams.keys()]) if (credentialKey.test(key)) url.searchParams.delete(key);
      return url.toString();
    } catch { return value; }
  }
  return value;
}
