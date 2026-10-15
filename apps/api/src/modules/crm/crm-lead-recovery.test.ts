import { describe, expect, it, vi } from 'vitest';
import { createCrmService } from './crm.service.js';

const at = new Date('2026-10-15T18:00:00Z');
function fixture(noteStatus = 200) {
  const contact = { id: 'contact', workspaceId: 'workspace', name: 'Synthetic', phone: '15550000001', email: null, company: null, atomicCrmContactId: '42', atomicCrmLeadId: null as string | null };
  let operation: any = null;
  const actions: any[] = [];
  const model = {
    upsert: vi.fn(async ({ create }: any) => { operation ??= { id: 'operation', remoteLeadId: null, remoteContactId: null, remoteCompanyId: null, leaseToken: null, leaseUntil: null, lastError: null, createdAt: at, updatedAt: at, ...create }; return { ...operation }; }),
    findUnique: vi.fn(async () => operation ? { ...operation } : null),
    updateMany: vi.fn(async ({ where, data }: any) => {
      if (!operation || (where.leaseToken !== undefined && where.leaseToken !== operation.leaseToken)) return { count: 0 };
      if (where.OR && operation.leaseToken && operation.leaseUntil > at) return { count: 0 };
      Object.assign(operation, data); return { count: 1 };
    })
  };
  const db: any = { contact: { findUnique: vi.fn(async () => ({ ...contact })), update: vi.fn(async ({ data }: any) => { Object.assign(contact, data); return { ...contact }; }) }, crmLeadSync: model,
    crmSyncAction: { create: vi.fn(async ({ data }: any) => { const action = { id: 'action', createdAt: at, updatedAt: at, ...data }; actions.push(action); return action; }), findMany: vi.fn(async () => actions) } };
  db.$transaction = vi.fn(async (run: any) => run(db));
  const response = (status: number, id: number) => new Response(JSON.stringify({ data: { id } }), { status, headers: { 'content-type': 'application/json' } });
  const fetchCrm = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/records/contacts/42') return response(200, 42);
    if (path === '/api/records/leads' && init?.method === 'POST') return response(201, 77);
    if (path === '/api/records/leads/77') return response(200, 77);
    if (path === '/api/records/contact_notes') return response(noteStatus, 88);
    throw new Error(`Unexpected synthetic CRM request: ${path}`);
  });
  const service = createCrmService(db, { vinculaApiUrl: 'https://crm.invalid/api', fetch: fetchCrm as typeof fetch, now: () => at } as never);
  const create = () => service.createLead({ workspaceId: contact.workspaceId, contactId: contact.id, title: 'Synthetic opportunity', vinculaToken: 'synthetic-token' });
  const leadPosts = () => fetchCrm.mock.calls.filter(([url, init]) => String(url).endsWith('/records/leads') && init?.method === 'POST');
  const notePosts = () => fetchCrm.mock.calls.filter(([url]) => String(url).endsWith('/records/contact_notes'));
  return { contact, db, model, fetchCrm, create, leadPosts, notePosts, operation: () => operation, setOperation: (value: any) => { operation = value; }, response, actions };
}

describe('durable CRM lead synchronization', () => {
  it('persists a confirmed lead before a note503 and conserves note uncertainty across retries', async () => {
    const f = fixture(503);
    await expect(f.create()).rejects.toMatchObject({ code: 'CRM_NOTE_DELIVERY_UNCERTAIN', statusCode: 409 });
    expect(f.contact.atomicCrmLeadId).toBe('77'); expect(f.operation().state).toBe('note_uncertain');
    await expect(f.create()).rejects.toMatchObject({ code: 'CRM_NOTE_DELIVERY_UNCERTAIN' });
    expect(f.leadPosts()).toHaveLength(1); expect(f.notePosts()).toHaveLength(1);
    expect(f.actions.some(action => action.status === 'review_required')).toBe(true);
  });
  it('retries a provably rejected note on the already persisted lead', async () => {
    const f = fixture(403); await expect(f.create()).rejects.toMatchObject({ code: 'VINCULA_SYNC_FAILED', statusCode: 403 });
    expect(f.contact.atomicCrmLeadId).toBe('77'); expect(f.operation().state).toBe('note_pending');
    f.fetchCrm.mockImplementation(async url => f.response(200, String(url).endsWith('/contact_notes') ? 88 : 77));
    await expect(f.create()).resolves.toMatchObject({ status: 'completed', result: expect.objectContaining({ vinculaLeadId: '77' }) });
    expect(f.leadPosts()).toHaveLength(1); expect(f.notePosts()).toHaveLength(2); expect(f.operation().state).toBe('completed');
  });
  it('fences concurrent create calls without holding a database transaction over network I/O', async () => {
    const f = fixture(); let enter!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { enter = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
    const original = f.fetchCrm.getMockImplementation()!;
    f.fetchCrm.mockImplementation(async (url, init) => { if (String(url).endsWith('/records/leads')) { enter(); await hold; } return original(url, init); });
    const first = f.create(); await started;
    await expect(f.create()).rejects.toMatchObject({ code: 'CRM_SYNC_IN_PROGRESS', statusCode: 409 });
    release(); await expect(first).resolves.toMatchObject({ status: 'completed' }); expect(f.leadPosts()).toHaveLength(1);
  });
  it('never recreates a lead after recovering an interrupted creating state', async () => {
    const f = fixture(); f.setOperation({ id: 'operation', workspaceId: 'workspace', contactId: 'contact', state: 'creating_lead', title: 'Synthetic', leaseToken: null, leaseUntil: null });
    await expect(f.create()).rejects.toMatchObject({ code: 'CRM_LEAD_DELIVERY_UNCERTAIN', statusCode: 409 });
    expect(f.fetchCrm).not.toHaveBeenCalled();
  });
  it('fails before provider I/O when durable claiming is unavailable', async () => {
    const f = fixture(); f.model.updateMany.mockRejectedValue(new Error('DB unavailable'));
    await expect(f.create()).rejects.toThrow('DB unavailable'); expect(f.fetchCrm).not.toHaveBeenCalled();
  });
});
