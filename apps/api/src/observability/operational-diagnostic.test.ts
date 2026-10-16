import { describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/node';
import { createFailureReporter, privateEvent } from './glitchtip.js';
import { describeFailure, diagnosticTags, failureCode, safeFrame } from './operational-diagnostic.js';
import { WahaClientError } from '../modules/waha/waha.client.js';
import { WahaDestinationError } from '../modules/waha/waha-destination.js';

const PRIVATE = 'PRIVATE_CUSTOMER_TOKEN_5511999999999';
function proxyError() {
  const error = new TypeError(`ownKeys trap result did not include '$on' ${PRIVATE}`);
  error.stack = `TypeError: ${PRIVATE}\n at secretCustomerFunction (file:///private/operator/apps/api/src/modules/agents/agent-runtime.ts:1539:27)\n at db (/private/operator/secrets/${PRIVATE}.ts:5:2)\n at remote (https://private.invalid/token:2:4)`;
  return error;
}
describe('operational technical diagnostics', () => {
  it('preserves the Prisma technical failure and relative location without arbitrary text', () => {
    const d = describeFailure('agent_runtime', proxyError());
    expect(d).toMatchObject({ type: 'TypeError', code: 'PRISMA_PROXY_OWN_KEYS', technical_cause: 'prisma_proxy_invariant',
      operation: 'run_for_message', component: 'agents', recovery: 'unknown', impact: 'unknown',
      frames: [{ filename: 'modules/agents/agent-runtime.ts', lineno: 1539, colno: 27 }] });
    expect(d.correlation_id).toMatch(/^op_[a-f0-9]{32}$/);
    expect(JSON.stringify(d)).not.toMatch(/PRIVATE_|secretCustomerFunction|private\/operator|https:|vars|context_line/);
  });
  it('preserves a WAHA cause behind an uncertain-delivery wrapper and bounds cycles', () => {
    const error = Object.assign(new Error(PRIVATE), { name: 'OutboundUncertainError', causeError: new WahaClientError(500) });
    Object.assign(error.causeError, { cause: error });
    const d = describeFailure('agent_runtime', error);
    expect(d).toMatchObject({ code: 'OUTBOUND_UNCERTAIN', impact: 'delivery_unconfirmed', recovery: 'unknown',
      causes: [{ type: 'WahaClientError', code: 'WAHA_HTTP_500', technical_cause: 'provider_http_failure' }] });
    expect(failureCode(new WahaClientError(503))).toBe('WAHA_HTTP_503');
    expect(describeFailure('agent_runtime', new WahaDestinationError())).toMatchObject({
      type: 'WahaDestinationError', code: 'WAHA_DESTINATION_UNRESOLVED', technical_cause: 'destination_resolution_failed' });
    expect(failureCode({ name: 'WahaClientError', statusCode: `${PRIVATE}` })).toBe('UNEXPECTED_ERROR');
    expect(describeFailure('fatal', new Proxy({}, { get() { throw Error(PRIVATE); } })).code).toBe('UNEXPECTED_ERROR');
  });
  it('rejects paths, frame variables, snippets, unsafe types and invented recovery', () => {
    for (const filename of ['/etc/passwd', '../app.ts', 'https://host/app.ts', 'app.ts?token=secret', 'modules/agents/customer-secret.ts']) {
      expect(safeFrame({ filename, lineno: 1 })).toBeUndefined();
    }
    const tags = { ...diagnosticTags(describeFailure('agent_runtime', proxyError())), error_type: PRIVATE,
      recovery: 'recovered', diagnostic_frame_1: `../${PRIVATE}:1:1`, cause_type_0: PRIVATE,
      cause_code_0: PRIVATE, correlation_id: 'customer_identifier' };
    const event = privateEvent({ tags: { ...tags, failure_point: 'agent_runtime', failure_code: 'PRISMA_PROXY_OWN_KEYS' },
      request: { data: PRIVATE }, extra: { sql: PRIVATE } });
    expect(event?.tags).toMatchObject({ error_type: 'UnknownError', recovery: 'unknown' });
    expect(JSON.stringify(event)).not.toContain(PRIVATE);
    expect(event?.exception?.values?.[0]?.stacktrace?.frames?.[0]).toEqual({ filename: 'modules/agents/agent-runtime.ts', lineno: 1539, colno: 27 });
  });
  it('keeps distinct technical failures separate while coalescing random operation samples', () => {
    const send = vi.fn(), reporter = createFailureReporter(send, () => 1000);
    expect(reporter('agent_runtime', proxyError())).toBe(true);
    expect(reporter('agent_runtime', proxyError())).toBe(false);
    expect(reporter('agent_runtime', new WahaClientError(500))).toBe(true);
    const differentLocation = proxyError(); differentLocation.stack = differentLocation.stack!.replace(':1539:', ':1700:');
    expect(reporter('agent_runtime', differentLocation)).toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
  });
  it('rebuilds real SDK envelopes including fatal originalException and cause chain', async () => {
    const envelopes: unknown[] = [];
    Sentry.initWithoutDefaultIntegrations({ dsn: 'https://test@example.invalid/1', defaultIntegrations: false,
      enableRuntimeChannelInjection: false, includeServerName: false, sendClientReports: false, beforeSend: privateEvent,
      transport: () => ({ send: async envelope => { envelopes.push(envelope); return { statusCode: 200 }; }, flush: async () => true }) });
    try {
      Sentry.captureException(Object.assign(proxyError(), { cause: new WahaClientError(500) }), { extra: { customer: PRIVATE } });
      await Sentry.flush(1000);
      const wire = JSON.stringify(envelopes);
      expect(envelopes).toHaveLength(1);
      expect(wire).toContain('prisma_proxy_invariant'); expect(wire).toContain('WAHA_HTTP_500');
      expect(wire).toContain('modules/agents/agent-runtime.ts');
      expect(wire).not.toMatch(/PRIVATE_|private\/operator|secretCustomerFunction|private.invalid/);
    } finally { await Sentry.close(1000); }
  });
});
