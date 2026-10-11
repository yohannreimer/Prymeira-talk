import { describe, expect, it, vi, afterEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { IngressJournal } from './journal.js';
import { createIngressHttp } from './http.js';
import * as reporting from '../../observability/glitchtip.js';

afterEach(() => vi.restoreAllMocks());
describe('ingress HTTP error visibility', () => {
  function appWith(db: unknown) {
    return createIngressHttp({ db: db as PrismaClient, journal: {} as IngressJournal,
      publisher: () => null, evolutionSecret: 'isolated-test-secret', wahaSecret: 'isolated-test-secret',
      workspaceAllowlist: new Set(['fixture']) });
  }
  it('reports a caught database failure while preserving the 503 retry response', async () => {
    const error = Object.assign(new Error('query PRIVATE_TOKEN'), { code: 'P2024' });
    const report = vi.spyOn(reporting, 'reportFailure').mockReturnValue(true);
    const app = appWith({ $transaction: vi.fn().mockRejectedValue(error) });
    try {
      const response = await app.inject({ method: 'POST', url: '/webhooks/evolution/fixture', payload: {} });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'ingress_unavailable' });
      expect(report).toHaveBeenCalledWith('ingress_http', error);
      expect(reporting.failureCode(error)).toBe('P2024');
    } finally { await app.close(); }
  });
  it('does not turn an expected unauthorized source into a monitoring incident', async () => {
    const report = vi.spyOn(reporting, 'reportFailure').mockReturnValue(true);
    const app = appWith({ $transaction: (callback: (tx: unknown) => unknown) => callback({}) });
    try {
      const response = await app.inject({ method: 'POST', url: '/webhooks/evolution/fixture', payload: {} });
      expect(response.statusCode).toBe(401);
      expect(report).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
