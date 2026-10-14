import { describe, expect, it } from 'vitest';
import { createFailureReporter, failureCode, privateEvent, initializeGlitchTip, reportFailure } from './glitchtip.js';
import * as Sentry from '@sentry/node';

describe('private error reporting', () => {
  it('stays disabled without a DSN and refuses a different destination', async () => {
    expect(await initializeGlitchTip('api', {})).toBe(false);
    expect(await initializeGlitchTip('api', { GLITCHTIP_DSN: 'https://test@third-party.invalid/1' })).toBe(false);
    expect(reportFailure('api', new Error('PRIVATE_TOKEN'))).toBe(false);
  });
  it('recognizes operational codes without leaking arbitrary exception text', () => {
    expect(failureCode({ code: 'P2024', message: 'query with PRIVATE_TOKEN' })).toBe('P2024');
    expect(failureCode(new Error('secret sql: unexpected end of hex escape'))).toBe('INVALID_UNICODE');
    expect(failureCode(new Error('HISTORY_HTTP_404 at https://private/token'))).toBe('HISTORY_HTTP_404');
    expect(failureCode({ code: 'PRIVATE_TOKEN', message: 'customer text' })).toBe('UNEXPECTED_ERROR');
    expect(failureCode('customer text')).toBe('UNEXPECTED_ERROR');
  });
  it('keeps known provider, initialization, broker and media failures distinguishable', () => {
    expect(failureCode({ errorCode: 'P1001', message: 'PRIVATE SQL' })).toBe('P1001');
    expect(failureCode('Evolution API request failed with status 404')).toBe('EVOLUTION_HTTP_404');
    expect(failureCode(new Error('HISTORY_DUPLICATE_MESSAGE'))).toBe('HISTORY_DUPLICATE_MESSAGE');
    expect(failureCode({ code: 'publish_deadline' })).toBe('INGRESS_PUBLISH_DEADLINE');
    expect(failureCode({ code: 'MEDIA_UNAVAILABLE' })).toBe('MEDIA_UNAVAILABLE');
    expect(privateEvent({ tags: { failure_point: 'effect_exhausted', failure_code: 'MEDIA_UNAVAILABLE' } })?.tags?.failure_code).toBe('MEDIA_UNAVAILABLE');
    expect(failureCode('PRIVATE customer message')).toBe('UNEXPECTED_ERROR');
  });
  it('rebuilds fatal events without request, user, exception text, breadcrumbs or contexts', () => {
    const output = privateEvent({ event_id: '123', release: 'ceceeceddd525904e67f64519a03adacb66f89ab',
      request: { url: 'https://private/token', headers: { Authorization: 'PRIVATE_TOKEN' }, data: 'customer text' },
      user: { email: 'private@example.com' }, extra: { receipt: 'PRIVATE_TOKEN' },
      contexts: { database: { query: 'customer text' } }, breadcrumbs: [{ message: 'customer text' }],
      exception: { values: [{ type: 'PRIVATE_TOKEN', value: 'customer text', stacktrace: { frames: [{ vars: { token: 'PRIVATE_TOKEN' } }] } }] },
      tags: { service: 'ingress_worker', connectionId: 'PRIVATE_TOKEN' } });
    expect(JSON.stringify(output)).not.toMatch(/PRIVATE_TOKEN|customer text|private@example|https:\/\/private/);
    expect(output?.fingerprint).toEqual(['talk', 'fatal', 'UNEXPECTED_ERROR']);
    expect(output?.tags?.service).toBe('ingress_worker');
  });
  it('retains safe codes and groups each failure point separately', () => {
    expect(privateEvent({ tags: { failure_point: 'application_dead_letter', failure_code: 'P2028' } })?.fingerprint)
      .toEqual(['talk', 'application_dead_letter', 'P2028']);
    expect(privateEvent({ release: 'PRIVATE_TOKEN', tags: { failure_point: 'PRIVATE_TOKEN', service: 'PRIVATE_TOKEN' } })?.release).toBeUndefined();
    expect(privateEvent({ type: 'transaction' })).toBeNull();
  });
  it('coalesces repetitions but reports retry exhaustion immediately as a separate incident', () => {
    let time = 1000;
    const events: string[] = [];
    const reporter = createFailureReporter(point => { events.push(point); }, () => time);
    expect(reporter('application_retry', { code: 'P2024' })).toBe(true);
    expect(reporter('application_retry', { code: 'P2024' })).toBe(false);
    expect(reporter('application_dead_letter', { code: 'P2024' })).toBe(true);
    time += 60_000;
    expect(reporter('application_retry', { code: 'P2024' })).toBe(true);
    expect(events).toEqual(['application_retry', 'application_dead_letter', 'application_retry']);
  });
  it('bounds an error storm and tolerates a broken monitoring transport', () => {
    let count = 0, time = 0;
    const reporter = createFailureReporter(() => { count++; }, () => time);
    for (let n = 0; n < 100; n++) reporter('api', { code: `P${2000 + n}` });
    expect(count).toBe(10);
    time = 60_000;
    expect(reporter('api', { code: 'P2000' })).toBe(true);
    expect(createFailureReporter(() => { throw new Error('offline'); })('api', new Error())).toBe(false);
  });
  it('removes private data from the real SDK transport envelope', async () => {
    const envelopes: unknown[] = [];
    Sentry.initWithoutDefaultIntegrations({ dsn: 'https://test@example.com/1', defaultIntegrations: false,
      enableRuntimeChannelInjection: false, includeServerName: false, sendClientReports: false,
      beforeSend: privateEvent, transport: () => ({
        send: async envelope => { envelopes.push(envelope); return { statusCode: 200 }; },
        flush: async () => true
      }) });
    try {
      Sentry.captureException(new Error('PRIVATE_TOKEN customer text'), {
        user: { email: 'private@example.com' }, extra: { body: 'PRIVATE_TOKEN' },
        contexts: { sql: { query: 'customer text' } },
        tags: { service: 'ingress_worker', failure_point: 'application_dead_letter', failure_code: 'P2024', secret: 'PRIVATE_TOKEN' }
      });
      await Sentry.flush(2000);
      expect(envelopes).toHaveLength(1);
      const wire = JSON.stringify(envelopes);
      expect(wire).toContain('application_dead_letter: P2024');
      expect(wire).not.toMatch(/PRIVATE_TOKEN|customer text|private@example/);
    } finally { await Sentry.close(2000); }
  });
});
