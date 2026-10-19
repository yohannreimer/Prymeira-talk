import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLeadConversionService } from './lead-conversion.service.js';

const url = process.env.MESSAGING_TEST_DATABASE_URL;

describe.skipIf(!url)('bulk lead conversion on PostgreSQL', () => {
  let db: PrismaClient;
  const workspaceId = `broadcast-regression-${randomUUID()}`;
  beforeAll(() => { db = new PrismaClient({ datasources: { db: { url } } }); });
  afterAll(async () => {
    await db.campaign.deleteMany({ where: { workspaceId } });
    await db.leadContactProvenance.deleteMany({ where: { workspaceId } });
    await db.leadList.deleteMany({ where: { workspaceId } });
    await db.contact.deleteMany({ where: { workspaceId } });
    await db.quickReply.deleteMany({ where: { workspaceId } });
    await db.tag.deleteMany({ where: { workspaceId } });
    await db.$disconnect();
  });

  it('imports 291 leads past five seconds and persists a draft without sending or duplicating contacts', async () => {
    const list = await db.leadList.create({ data: {
      workspaceId, name: '291 contacts', source: 'google_maps', criteria: {}
    } });
    const ids = Array.from({ length: 291 }, () => randomUUID());
    await db.lead.createMany({ data: ids.map((id, index) => ({
      id, workspaceId, listId: list.id, source: 'google_maps', sourceDedupeKey: id,
      companyName: `Company ${index}`, normalizedPhone: `55473031${String(index).padStart(4, '0')}`,
      phones: [`55473031${String(index).padStart(4, '0')}`]
    })) });
    // Real PostgreSQL delay models the observed production import taking longer than Prisma's 5s default.
    const delayed = {
      ...db,
      $transaction: (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { timeout?: number }) =>
        db.$transaction(async tx => {
          await tx.$executeRaw`SELECT pg_sleep(5.1)`;
          return callback(tx);
        }, options)
    };
    const service = createLeadConversionService(delayed as never);
    const imported = await service.importSelectedLeads({ workspaceId, selectedLeadIds: ids, actor: { id: 'test' } });
    expect(imported).toMatchObject({ requestedCount: 291, importedCount: 291, createdCount: 291, skippedCount: 0 });
    const draft = await createLeadConversionService(db).createCampaignDraftFromLeads({
      workspaceId, listId: list.id, selectedLeadIds: ids, originalSelectedLeadIds: ids
    });
    expect(draft).toMatchObject({ status: 'draft', contactCount: 291 });
    expect(await db.campaign.findUnique({ where: { id: draft.campaignId } })).toMatchObject({
      status: 'draft', mode: 'simulated', scheduledAt: null,
      audience: { rows: expect.any(Array), selectedCount: 291 }
    });
    expect(await db.campaignRecipient.count({ where: { workspaceId } })).toBe(0);
    const retry = await createLeadConversionService(db).importSelectedLeads({ workspaceId, selectedLeadIds: ids, actor: { id: 'test' } });
    expect(retry).toMatchObject({ createdCount: 0, reconciledCount: 291 });
    expect(await db.contact.count({ where: { workspaceId } })).toBe(291);
  }, 30_000);
});
