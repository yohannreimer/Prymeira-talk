import { describe, expect, it } from 'vitest';
import { buildCtwaPayload, resolveCtwaConfig, stableCtwaEventId } from './ctwa-payload.js';
const config = { datasetId: '123', whatsappBusinessAccountId: '789', pageId: '456', accessToken: 'synthetic-token', enabled: true, testEventCode: 'TEST123' };
const base = { workspaceId: 'workspace-a', channelId: 'channel-a', attributionId: 'attribution-a', ctwaClid: 'Synthetic-Opaque+Click=', eventTime: new Date('2026-10-19T12:00:00Z') };
describe('CTWA Meta payload and per-workspace secret', () => {
  it.each(['LeadSubmitted', 'QualifiedLead', 'Purchase'] as const)('builds %s without conversation PII', name => {
    const payload = buildCtwaPayload({ ...base, name, ...(name === 'Purchase' ? { orderId: 'order-1', value: 49.95, currency: 'BRL' } : {}) }, config);
    expect(payload.data[0]).toMatchObject({ event_name: name, action_source: 'business_messaging', messaging_channel: 'whatsapp', user_data: { ctwa_clid: base.ctwaClid, page_id: '456', whatsapp_business_account_id: '789' } });
    expect(payload.test_event_code).toBe('TEST123');
    expect(JSON.stringify(payload)).not.toMatch(/synthetic-token|workspace-a|channel-a|attribution-a|phone|email/);
    expect(payload).toEqual(buildCtwaPayload({ ...base, name, ...(name === 'Purchase' ? { orderId: 'order-1', value: 49.95, currency: 'BRL' } : {}) }, config));
  });
  it('scopes stable IDs and distinct orders', () => {
    const id = stableCtwaEventId('w', 'c', 'a', 'LeadSubmitted');
    expect(id).not.toBe(stableCtwaEventId('other', 'c', 'a', 'LeadSubmitted'));
    const purchase = (orderId: string) => buildCtwaPayload({ ...base, name: 'Purchase', orderId, value: 1, currency: 'BRL' }, config).data[0]!.event_id;
    expect(purchase('one')).not.toBe(purchase('two'));
  });
  it.each([0, -1, NaN, Infinity, 0.00001, 1.23456, 1000000000001])('rejects invalid purchase value %s', value => { expect(() => buildCtwaPayload({ ...base, name: 'Purchase', orderId: 'order', value, currency: 'BRL' }, config)).toThrow(); });
  it.each([0.0001, 1.2345, 2.95, 1000000000000])('preserves representable purchase value %s exactly', value => {
    expect(buildCtwaPayload({ ...base, name: 'Purchase', orderId: 'order', value, currency: 'BRL' }, config).data[0]!.custom_data!.value).toBe(value);
  });
  it('has no secret/config fallback between tenants and defaults disabled', () => {
    const secret = JSON.stringify({ a: config, b: { ...config, enabled: false }, c: { ...config, enabled: undefined } });
    expect(resolveCtwaConfig(secret, 'a')).toEqual(config);
    for (const id of ['b', 'c', 'missing', 'constructor', '__proto__']) expect(resolveCtwaConfig(secret, id)).toBeNull();
    for (const invalid of [undefined, '{}', 'invalid', JSON.stringify({ a: { ...config, datasetId: '../other' } })]) expect(resolveCtwaConfig(invalid, 'a')).toBeNull();
  });
});
