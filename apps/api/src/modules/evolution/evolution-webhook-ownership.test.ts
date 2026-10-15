import { describe, expect, it } from 'vitest';
import { evolutionWebhookProvesOwnership } from './evolution-webhook-ownership.js';
const expected = { webhookUrl: 'https://talk.example.invalid/webhooks/evolution/tenant-a', webhookSecret: 'synthetic-test-secret' };
const valid = { enabled: true, url: expected.webhookUrl, headers: { 'x-prymeira-talk-secret': expected.webhookSecret } };
describe('read-only Evolution tenant attestation', () => {
  it('requires the exact enabled workspace callback and shared secret', () => {
    expect(evolutionWebhookProvesOwnership(valid, expected)).toBe(true);
    expect(evolutionWebhookProvesOwnership({ webhook: valid }, expected)).toBe(true);
    expect(evolutionWebhookProvesOwnership({ ...valid, headers: { 'X-Prymeira-Talk-Secret': expected.webhookSecret } }, expected)).toBe(true);
  });
  it.each([null, {}, { ...valid, enabled: false }, { ...valid, url: `${valid.url}-other` }, { ...valid, headers: {} },
    { ...valid, headers: { 'x-prymeira-talk-secret': 'foreign' } }, { ...valid, headers: { 'x-prymeira-talk-secret': expected.webhookSecret, 'X-Prymeira-Talk-Secret': expected.webhookSecret } }])('rejects incomplete or foreign remote proof %#', raw => {
    expect(evolutionWebhookProvesOwnership(raw, expected)).toBe(false);
  });
});
