import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCrmService } from './crm.service.js';

const url = process.env.MESSAGING_TEST_DATABASE_URL;
describe.skipIf(!url)('durable CRM synchronization on owned PostgreSQL', () => {
  let db: PrismaClient;
  const workspaces: string[] = [];
  beforeAll(() => {
    const target = new URL(url!);
    if (target.hostname !== '127.0.0.1' || target.port !== (process.env.TALK_TEST_POSTGRES_PORT ?? '55439') || target.pathname !== '/messaging_test') throw new Error('Owned messaging_test required');
    db = new PrismaClient({ datasources: { db: { url } } });
  });
  afterAll(async () => {
    if (!db) return;
    await db.crmSyncAction.deleteMany({ where: { workspaceId: { in: workspaces } } });
    await db.contact.deleteMany({ where: { workspaceId: { in: workspaces } } }); await db.$disconnect();
  });
  async function fixture(noteStatus = 200) {
    const workspaceId = `crm-sync-${randomUUID()}`; workspaces.push(workspaceId);
    const contact = await db.contact.create({ data: { workspaceId, phone: '15550000001', name: 'Synthetic', atomicCrmContactId: '42' } });
    const response = (status: number, id: number) => new Response(JSON.stringify({ data: { id } }), { status, headers: { 'content-type': 'application/json' } });
    const fetchCrm = vi.fn(async (request: string | URL | Request) => {
      const path = new URL(String(request)).pathname;
      if (path === '/api/records/contacts/42') return response(200, 42);
      if (path === '/api/records/leads' || path === '/api/records/leads/77') return response(200, 77);
      if (path === '/api/records/contact_notes') return response(noteStatus, 88);
      throw new Error(`Unexpected synthetic CRM request ${path}`);
    });
    const service = () => createCrmService(db as never, { vinculaApiUrl: 'https://crm.invalid/api', fetch: fetchCrm as typeof fetch });
    const create = () => service().createLead({ workspaceId, contactId: contact.id, title: 'Synthetic interest', vinculaToken: 'synthetic' });
    const operation = () => db.crmLeadSync.findUniqueOrThrow({ where: { workspaceId_contactId: { workspaceId, contactId: contact.id } } });
    return { workspaceId, contact, fetchCrm, create, operation, response };
  }
  it('keeps the confirmed lead identity after note503 and restart without repeating either POST', async () => {
    const f = await fixture(503);
    await expect(f.create()).rejects.toMatchObject({ code: 'CRM_NOTE_DELIVERY_UNCERTAIN', statusCode: 409 });
    expect((await db.contact.findUniqueOrThrow({ where: { id: f.contact.id } })).atomicCrmLeadId).toBe('77');
    expect(await f.operation()).toMatchObject({ state: 'note_uncertain', remoteLeadId: '77', leaseToken: null });
    await expect(f.create()).rejects.toMatchObject({ code: 'CRM_NOTE_DELIVERY_UNCERTAIN' });
    expect(f.fetchCrm.mock.calls.filter(([request]) => String(request).endsWith('/records/leads'))).toHaveLength(1);
    expect(f.fetchCrm.mock.calls.filter(([request]) => String(request).endsWith('/records/contact_notes'))).toHaveLength(1);
    expect(await db.crmSyncAction.findFirst({ where: { workspaceId: f.workspaceId } })).toMatchObject({ status: 'review_required' });
  });
  it('fences a concurrent request while external I/O is pending without holding a database transaction', async () => {
    const f = await fixture(); let enter!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { enter = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
    const original = f.fetchCrm.getMockImplementation()!;
    f.fetchCrm.mockImplementation(async request => { if (String(request).endsWith('/records/leads')) { enter(); await hold; } return original(request); });
    const first = f.create(); await started;
    expect((await f.operation()).state).toBe('creating_lead');
    await expect(f.create()).rejects.toMatchObject({ code: 'CRM_SYNC_IN_PROGRESS', statusCode: 409 });
    release(); await expect(first).resolves.toMatchObject({ status: 'completed' });
    expect(f.fetchCrm.mock.calls.filter(([request]) => String(request).endsWith('/records/leads'))).toHaveLength(1);
  });
  it('creates one remote lead when the initial durable operation is raced by multiple callers', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.create(), f.create(), f.create()]);
    expect(results.some(result => result.status === 'fulfilled')).toBe(true);
    for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'CRM_SYNC_IN_PROGRESS' });
    expect(f.fetchCrm.mock.calls.filter(([request]) => String(request).endsWith('/records/leads'))).toHaveLength(1);
    expect(f.fetchCrm.mock.calls.filter(([request]) => String(request).endsWith('/records/contact_notes'))).toHaveLength(1);
  });

  it('keeps a crash after dispatch uncertain rather than creating another lead', async () => {
    const f = await fixture();
    await db.crmLeadSync.create({ data: { workspaceId: f.workspaceId, contactId: f.contact.id, title: 'Synthetic', state: 'creating_lead', leaseToken: randomUUID(), leaseUntil: new Date(0) } });
    await expect(f.create()).rejects.toMatchObject({ code: 'CRM_LEAD_DELIVERY_UNCERTAIN' });
    expect(f.fetchCrm).not.toHaveBeenCalled(); expect((await f.operation()).state).toBe('lead_uncertain');
  });
  it('resumes an explicitly rejected note on the existing lead', async () => {
    const f = await fixture(403); await expect(f.create()).rejects.toMatchObject({ code: 'VINCULA_SYNC_FAILED' });
    f.fetchCrm.mockImplementation(async () => f.response(200, 88));
    await expect(f.create()).resolves.toMatchObject({ status: 'completed', result: expect.objectContaining({ vinculaLeadId: '77' }) });
    expect(f.fetchCrm.mock.calls.filter(([request]) => String(request).endsWith('/records/leads'))).toHaveLength(1);
    expect((await f.operation()).state).toBe('completed');
  });
});
