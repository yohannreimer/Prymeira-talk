import { afterEach, describe, expect, it, vi } from 'vitest';
import * as monitor from './glitchtip.js';
import { observeOperationalOperation, rememberOperationalError, reportOperationalException } from './operation-observer.js';

afterEach(() => vi.restoreAllMocks());
describe('handled operational failures', () => {
  it('reports caught errors converted to failed once, retaining technical context without changing results', async () => {
    const report = vi.spyOn(monitor, 'reportFailure').mockReturnValue(true);
    const result = { status: 'failed', message: 'PRIVATE_CUSTOMER_TEXT' };
    const response = await observeOperationalOperation('agent_scheduler', () => observeOperationalOperation('agent_runtime', async () => {
      rememberOperationalError(new TypeError("ownKeys did not include '$on' PRIVATE_CUSTOMER_TEXT"));
      return result;
    }));
    expect(response).toBe(result); expect(Object.keys(response)).toEqual(['status', 'message']);
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]?.[2]?.diagnostic).toMatchObject({ type: 'TypeError', code: 'PRISMA_PROXY_OWN_KEYS', impact: 'operation_failed', recovery: 'unknown' });
    expect(JSON.stringify(report.mock.calls)).not.toContain('PRIVATE_CUSTOMER_TEXT');
  });
  it('does not report completed, handoff or intentionally skipped results', async () => {
    const report = vi.spyOn(monitor, 'reportFailure').mockReturnValue(true);
    for (const status of ['completed', 'skipped', 'handoff_requested']) await observeOperationalOperation('agent_runtime', async () => ({ status }));
    expect(report).not.toHaveBeenCalled();
  });
  it('reports a technical failure that was recovered by human handoff once across nested observers', async () => {
    const report = vi.spyOn(monitor, 'reportFailure').mockReturnValue(true);
    const result = { status: 'handoff_requested', message: 'PRIVATE_CUSTOMER_TEXT' };
    const response = await observeOperationalOperation('agent_scheduler', () => observeOperationalOperation('agent_runtime', async () => {
      rememberOperationalError(new TypeError("ownKeys omitted '$on' PRIVATE_CUSTOMER_TEXT"));
      return result;
    }));
    expect(response).toBe(result);
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]?.[2]?.diagnostic).toMatchObject({ type: 'TypeError', code: 'PRISMA_PROXY_OWN_KEYS', impact: 'operation_failed' });
    expect(JSON.stringify(report.mock.calls)).not.toContain('PRIVATE_CUSTOMER_TEXT');
  });
  it('keeps escaped errors and monitoring failures from changing caller behavior', async () => {
    const report = vi.spyOn(monitor, 'reportFailure').mockImplementation(() => { throw Error('monitor offline'); });
    const error = new Error('PRIVATE_CUSTOMER_TEXT');
    await expect(observeOperationalOperation('agent_scheduler', () => observeOperationalOperation('agent_runtime', async () => { throw error; }))).rejects.toBe(error);
    reportOperationalException('agent_scheduler', error);
    expect(report).toHaveBeenCalledOnce();
    await expect(observeOperationalOperation('agent_runtime', async () => ({ status: 'failed' }))).resolves.toEqual({ status: 'failed' });
  });
  it('uses independent correlations for concurrent operations, including reused failure objects', async () => {
    const report = vi.spyOn(monitor, 'reportFailure').mockReturnValue(true);
    const sameResult = { status: 'failed' };
    await Promise.all([1, 2].map(() => observeOperationalOperation('agent_runtime', async () => { await Promise.resolve(); return sameResult; })));
    const ids = report.mock.calls.map(call => call[2]?.diagnostic?.correlation_id);
    expect(new Set(ids).size).toBe(2);
  });

  it('retains the original cause when recording the failed run also throws', async () => {
    const report = vi.spyOn(monitor, 'reportFailure').mockReturnValue(true);
    const persistence = Object.assign(new Error('PRIVATE_SQL_FIXTURE'), { code: 'P2003' });
    await expect(observeOperationalOperation('agent_runtime', async () => {
      rememberOperationalError(new TypeError("ownKeys omitted '$on' PRIVATE_FIXTURE"));
      throw persistence;
    })).rejects.toBe(persistence);
    expect(report.mock.calls[0]?.[2]?.diagnostic).toMatchObject({ code: 'P2003',
      causes: [{ type: 'TypeError', code: 'PRISMA_PROXY_OWN_KEYS' }] });
    expect(JSON.stringify(report.mock.calls)).not.toMatch(/PRIVATE_/);
  });
});
