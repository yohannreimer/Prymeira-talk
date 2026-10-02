import { describe, expect, it } from 'vitest';
import { canWrite, classifySendFailure, shouldReturnToPrimary, writerCandidates, type RoutableChannel, type RoutableConnection } from './outbound-routing.js';

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
  it('without redundancy the legacy Evolution connection is the only candidate, even if its record is stale', () => {
    expect(ids(channel({ redundancyEnabled: false }))).toEqual(['evo']);
    const stale = channel({ redundancyEnabled: false }, [conn({ id: 'evo', provider: 'evolution', status: 'disconnected', health: 'unhealthy' }), conn({ id: 'waha', provider: 'waha' })]);
    expect(ids(stale)).toEqual(['evo']);
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

  it('is empty when nothing may write, and never offers a WAHA that is not the same number', () => {
    expect(ids(channel({}, [conn({ id: 'evo', provider: 'evolution', status: 'disconnected' }), conn({ id: 'waha', provider: 'waha', status: 'disconnected' })]))).toEqual([]);
    expect(ids(channel({}, [conn({ id: 'evo', provider: 'evolution', status: 'disconnected' }), conn({ id: 'waha', provider: 'waha', verifiedPhoneNumber: '5547000000000' })]))).toEqual([]);
  });
});

describe('classifySendFailure', () => {
  const http = (statusCode: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(`status ${statusCode}`), { statusCode, ...extra });
  it.each([
    ['connection refused (direct code)', Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), 'not_delivered'],
    ['connection refused (fetch cause)', Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), 'not_delivered'],
    ['DNS failure', Object.assign(new Error('x'), { code: 'ENOTFOUND' }), 'not_delivered'],
    ['validation error 400', http(400), 'not_delivered'],
    ['unauthorised 401', http(401), 'not_delivered'],
    ['unknown session 404', http(404), 'not_delivered'],
    ['session not working 422', http(422), 'not_delivered'],
    ['500 saying the connection was closed', http(500, { responseBody: { message: 'Connection Closed' } }), 'not_delivered'],
    ['500 saying the instance is not connected', http(500, { responseBody: 'instance not connected' }), 'not_delivered'],
    ['plain 500', http(500), 'uncertain'],
    ['gateway timeout 504', http(504), 'uncertain'],
    ['bad gateway 502', http(502), 'uncertain'],
    ['request timeout', Object.assign(new Error('timeout'), { name: 'TimeoutError' }), 'uncertain'],
    ['aborted request', Object.assign(new Error('aborted'), { name: 'AbortError' }), 'uncertain'],
    ['connection reset after sending', Object.assign(new Error('reset'), { code: 'ECONNRESET' }), 'uncertain'],
    ['unknown error', new Error('boom'), 'uncertain'],
    ['not an error', 'oops', 'uncertain']
  ])('%s -> %s', (_name, error, expected) => { expect(classifySendFailure(error)).toBe(expected); });
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
