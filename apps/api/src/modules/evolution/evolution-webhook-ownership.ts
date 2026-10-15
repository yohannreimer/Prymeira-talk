import { createHash, timingSafeEqual } from 'node:crypto';
/** Read-only attestation. A session name is not proof of tenant ownership. */
export function evolutionWebhookProvesOwnership(raw: unknown, expected: { webhookUrl: string; webhookSecret: string }): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;
  const hook = record.webhook && typeof record.webhook === 'object' && !Array.isArray(record.webhook)
    ? record.webhook as Record<string, unknown> : record;
  if (hook.enabled !== true || hook.url !== expected.webhookUrl || !expected.webhookSecret || !hook.headers || typeof hook.headers !== 'object' || Array.isArray(hook.headers)) return false;
  const entries = Object.entries(hook.headers).filter(([key]) => key.toLowerCase() === 'x-prymeira-talk-secret');
  if (entries.length !== 1 || typeof entries[0]![1] !== 'string') return false;
  return timingSafeEqual(createHash('sha256').update(entries[0]![1]).digest(), createHash('sha256').update(expected.webhookSecret).digest());
}
