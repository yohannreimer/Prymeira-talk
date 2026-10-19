import { describe, expect, it } from 'vitest';
import { canWrite, classifySendFailure, OutboundPreSendError, shouldReturnToPrimary, writerCandidates, type RoutableChannel, type RoutableConnection } from './outbound-routing.js';

import { EvolutionClientError } from '../evolution/evolution.client.js';
import { WahaClientError } from '../waha/waha.client.js';
import { WahaDestinationError } from '../waha/waha-destination.js';

const conn = (over: Partial<RoutableConnection> & Pick<RoutableConnection, 'id' | 'provider'>): RoutableConnection =>
  ({ status: 'connected', health: 'healthy', eligible: true, verifiedPhoneNumber: '5547999990000', lastHealthyAt: new Date('2026-10-02T12:00:00Z'), ...over });
const channel = (over: Partial<RoutableChannel> = {}, connections: RoutableConnection[] = [conn({ id: 'evo', provider: 'evolution' }), conn({ id: 'waha', provider: 'waha' })]): RoutableChannel =>
  ({ redundancyEnabled: true, activeConnectionId: 'evo', connections, ...over });
const ids = (c: RoutableChannel) => writerCandidates(c).map(x => x.id);

describe('canWrite', () => {
  it('lets Evolution write while connected and not unhealthy, regardless of redundancy', () => {
    const c = channel({ redundancyEnabled: false });
    expect(canWrite(c.connections[0]!, c)).toBe(true);
    expect(canWrite({ ...c.connections[0]!, health: 'degraded' }, c)).toBe(true);
    expect(canWrite({ ...c.connections[0]!, health: 'unhealthy' }, c)).toBe(false);
    expect(canWrite({ ...c.connections[0]!, status: 'disconnected' }, c)).toBe(false);
  });

  it('uses a trusted immutable WAHA-only anchor while refusing a primary on another number', () => {
    const c = channel({ verifiedMessagingPhoneNumber: '5547999990000' }, [conn({ id: 'evo', provider: 'evolution', verifiedPhoneNumber: '5511888882222' }), conn({ id: 'waha', provider: 'waha' })]);
    expect(writerCandidates(c).map(row => row.id)).toEqual(['waha']);
    expect(canWrite({ ...c.connections[1]!, verifiedPhoneNumber: '5511888882222' }, c)).toBe(false);
    expect(canWrite({ ...c.connections[1]!, lastHealthyAt: null }, c)).toBe(false);
  });
  it('lets WAHA write only with redundancy on, eligible, and the same verified number as Evolution', () => {
    const c = channel();
    const waha = c.connections[1]!;
    expect(canWrite(waha, c)).toBe(true);
    expect(canWrite(waha, channel({ redundancyEnabled: false }))).toBe(false);
    expect(canWrite({ ...waha, eligible: false }, c)).toBe(false);
    expect(canWrite({ ...waha, verifiedPhoneNumber: null }, c)).toBe(false);
    expect(canWrite({ ...waha, verifiedPhoneNumber: '5547888880000' }, c)).toBe(false);
  });
});

describe('writerCandidates', () => {
  it('without redundancy returns only a usable Evolution connection', () => {
    expect(ids(channel({ redundancyEnabled: false }))).toEqual(['evo']);
    const stale = channel({ redundancyEnabled: false }, [conn({ id: 'evo', provider: 'evolution', status: 'disconnected', health: 'unhealthy' }), conn({ id: 'waha', provider: 'waha' })]);
    expect(ids(stale)).toEqual([]);
  });

  it('puts the active writer first and the other connection second', () => {
    expect(ids(channel())).toEqual(['evo', 'waha']);
    expect(ids(channel({ activeConnectionId: 'waha' }))).toEqual(['waha', 'evo']);
  });

  it('drops a connection that cannot write, so the other one carries the send', () => {
    const down = channel({}, [conn({ id: 'evo', provider: 'evolution', health: 'unhealthy' }), conn({ id: 'waha', provider: 'waha' })]);
    expect(ids(down)).toEqual(['waha']);
    const wahaDown = channel({ activeConnectionId: 'waha' }, [conn({ id: 'evo', provider: 'evolution' }), conn({ id: 'waha', provider: 'waha', status: 'disconnected' })]);
    expect(ids(wahaDown)).toEqual(['evo']);
  });

  it('fences physical maintenance without revoking the same-number secondary writer', () => {
    const c = channel({}, [conn({ id: 'evo', provider: 'evolution', lifecycleGeneration: 1 }), conn({ id: 'waha', provider: 'waha', lifecycleGeneration: 0 })]);
    expect(ids(c)).toEqual(['waha']);
    c.connections[1]!.lifecycleGeneration = 3;
    expect(ids(c)).toEqual([]);
  });
  it('is empty when nothing may write, and never offers a WAHA that is not the same number', () => {
    expect(ids(channel({}, [conn({ id: 'evo', provider: 'evolution', status: 'disconnected' }), conn({ id: 'waha', provider: 'waha', status: 'disconnected' })]))).toEqual([]);
    expect(ids(channel({}, [conn({ id: 'evo', provider: 'evolution', status: 'disconnected' }), conn({ id: 'waha', provider: 'waha', verifiedPhoneNumber: '5547000000000' })]))).toEqual([]);
  });
});

describe('classifySendFailure', () => {
  const http = (statusCode: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(`status ${statusCode}`), { statusCode, ...extra });
  describe.each(['evolution', 'waha'] as const)('%s', provider => {
    it.each([
      ['connection refused (direct code)', Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), 'not_delivered'],
      ['connection refused (fetch cause)', Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), 'not_delivered'],
      ['DNS failure', Object.assign(new Error('x'), { code: 'ENOTFOUND' }), 'not_delivered'],
      ['HTTP response with network-like error', http(400, { code: 'ECONNREFUSED' }), 'uncertain'],
      ['500 saying the connection was closed', http(500, { responseBody: { message: 'Connection Closed' } }), 'uncertain'],
      ['500 saying the instance is not connected', http(500, { responseBody: 'instance not connected' }), 'uncertain'],
      ['request timeout', Object.assign(new Error('timeout'), { name: 'TimeoutError' }), 'uncertain'],
      ['aborted request', Object.assign(new Error('aborted'), { name: 'AbortError', cause: { code: 'ECONNREFUSED' } }), 'uncertain'],
      ['connection reset after sending', Object.assign(new Error('reset'), { code: 'ECONNRESET' }), 'uncertain'],
      ['unknown error', new Error('boom'), 'uncertain'],
      ['not an error', 'oops', 'uncertain']
    ])('%s -> %s', (_name, error, expected) => { expect(classifySendFailure(error, provider)).toBe(expected); });

    it.each([400, 401, 403, 404, 422, 500, 502, 504])('keeps generic and typed HTTP %s uncertain without pre-send evidence', status => {
      expect(classifySendFailure(http(status), provider)).toBe('uncertain');
      const typed = provider === 'evolution' ? new EvolutionClientError(status, { message: 'Connection Closed' }) : new WahaClientError(status);
      expect(classifySendFailure(typed, provider)).toBe('uncertain');
    });
    it('recognizes only the matching provider local preflight rejection', () => {
      const error = new OutboundPreSendError(provider, 'TEMPLATE_NOT_SUPPORTED');
      expect(classifySendFailure(error, provider)).toBe('not_delivered');
      expect(classifySendFailure(error, provider === 'evolution' ? 'waha' : 'evolution')).toBe('uncertain');
    });
  });
  it('recognizes a local WAHA destination rejection rather than generic validation text', () => {
    expect(classifySendFailure(new WahaDestinationError(), 'waha')).toBe('not_delivered');
    expect(classifySendFailure(new WahaDestinationError(), 'evolution')).toBe('uncertain');
    expect(classifySendFailure(http(422, { message: 'WAHA_DESTINATION_UNRESOLVED' }), 'waha')).toBe('uncertain');
  });
  it('keeps the unavailable Evolution adapter preflight limited to Evolution', () => {
    const error = Object.assign(new Error('not configured'), { code: 'EVOLUTION_UNAVAILABLE', statusCode: 503 });
    expect(classifySendFailure(error, 'evolution')).toBe('not_delivered');
    expect(classifySendFailure(error, 'waha')).toBe('uncertain');
  });
});

describe('shouldReturnToPrimary', () => {
  const now = new Date('2026-10-02T12:20:00Z');
  const primary = conn({ id: 'evo', provider: 'evolution' });
  const healthySince = new Date('2026-10-02T12:05:00Z');
  it('returns only after ten unbroken healthy minutes with agreeing events, and only when it is not already the writer', () => {
    const base = { primary, healthySince, now, stableMs: 10 * 60_000, eventsAgree: true, activeConnectionId: 'waha' };
    expect(shouldReturnToPrimary(base)).toBe(true);
    expect(shouldReturnToPrimary({ ...base, activeConnectionId: 'evo' })).toBe(false);
    expect(shouldReturnToPrimary({ ...base, eventsAgree: false })).toBe(false);
    expect(shouldReturnToPrimary({ ...base, healthySince: new Date('2026-10-02T12:11:00Z') })).toBe(false);
    expect(shouldReturnToPrimary({ ...base, healthySince: null })).toBe(false);
    expect(shouldReturnToPrimary({ ...base, primary: { ...primary, health: 'degraded' } })).toBe(false);
    expect(shouldReturnToPrimary({ ...base, primary: { ...primary, status: 'connecting' } })).toBe(false);
  });
});
