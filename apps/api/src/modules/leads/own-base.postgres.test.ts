import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOwnBaseService, phoneKey, splitPhones } from './own-base.service.js';

const url = process.env.MESSAGING_TEST_DATABASE_URL;

describe('phone and city keys', () => {
  it('matches a number however it is written, with or without the 9th digit', () => {
    expect(phoneKey('+55 47 98837-2290')).toBe(phoneKey('554788372290'));
    expect(phoneKey('(47) 3031-2531')).toBe(phoneKey('+554730312531'));
    expect(splitPhones(['+554730312531 | +554734361111', '34329952', '47 9-8837-2290'])).toEqual({
      valid: ['554730312531', '554734361111', '5547988372290'], review: ['34329952'] });
  });
});

describe.skipIf(!url)('Base própria on PostgreSQL', () => {
  let db: PrismaClient;
  const workspaceId = `ws-${randomUUID()}`;
  beforeAll(() => { db = new PrismaClient({ datasources: { db: { url } } }); });
  afterAll(async () => {
    await db.campaign.deleteMany({ where: { workspaceId } });
    await db.channel.deleteMany({ where: { workspaceId } });
    await db.contact.deleteMany({ where: { workspaceId } });
    await db.leadList.deleteMany({ where: { workspaceId } });
    await db.leadRegion.deleteMany({ where: { workspaceId } });
    await db.$disconnect();
  });

  it('imports a spreadsheet in parts, files companies by region, marks dispatched ones and keeps lists to your region', async () => {
    const service = createOwnBaseService(db);
    const first = await service.importRows({ workspaceId, name: 'Leads Unificados', fileName: 'Leads.xlsx', done: false, rows: [
      { company: '3R FERRAMENTARIA E USINAGEM', phones: ['+554730312531 | +554734361111'], city: 'ARAQUARI', state: 'sc', region: 'Joinville / Araquari / Garuva', cnpj: '07515534000108' },
      { company: 'Abrastech', phones: ['34329952'], city: 'Araquari', region: 'Joinville / Araquari / Garuva' },
      { company: 'Ferraço Joinville', phones: ['+5547999015903'], city: 'JOINVILLE', region: 'Joinville / Araquari / Garuva' }
    ] });
    expect(first).toMatchObject({ saved: 3, withoutPhone: 1, total: 3 });
    await service.importRows({ workspaceId, listId: first.listId, name: 'Leads Unificados', fileName: 'Leads.xlsx', done: true, rows: [
      { company: 'Adalberto Maas Junior', phones: ['+554733750720'], city: 'CORUPA', region: 'Jaraguá e região' },
      { company: '2 Rios', phones: ['+554730439617'] },
      // The same company again (same CNPJ): updated, not duplicated.
      { company: '3R Ferramentaria', phones: ['+554730312531'], city: 'Araquari', region: 'Joinville / Araquari / Garuva', cnpj: '07.515.534/0001-08' }
    ] });
    expect(await db.lead.count({ where: { workspaceId } })).toBe(5);
    expect(await service.listRegions(workspaceId)).toEqual([
      { name: 'Joinville / Araquari / Garuva', cities: ['Araquari', 'Joinville'], seller: null, isMine: false },
      { name: 'Jaraguá e região', cities: ['Corupa'], seller: null, isMine: false }
    ]);

    // A campaign already reached Ferraço (stored with the 9th digit missing) and it answered afterwards.
    const contact = await db.contact.create({ data: { workspaceId, phone: '554799015903', name: 'Ferraço' } });
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID(), status: 'connected' } });
    const campaign = await db.campaign.create({ data: { workspaceId, name: 'Promo Chapa Preta', messageBody: 'oi', status: 'completed' } });
    const sentAt = new Date('2026-09-29T15:00:00Z');
    await db.campaignRecipient.create({ data: { workspaceId, campaignId: campaign.id, contactId: contact.id, status: 'sent', phoneSnapshot: '554799015903', sentAt } });
    const conversation = await db.conversation.create({ data: { workspaceId, channelId: channel.id, contactId: contact.id } });
    await db.message.create({ data: { workspaceId, conversationId: conversation.id, direction: 'inbound', type: 'text', body: 'Quero a tabela', status: 'delivered', createdAt: new Date('2026-10-01T12:00:00Z') } });

    const joinville = 'Joinville / Araquari / Garuva';
    const all = await service.page({ workspaceId, listId: first.listId, region: joinville, filter: 'all', page: 1, pageSize: 50 });
    expect(all.counts).toEqual({ never: 2, sent: 1, replied: 1, all: 3 });
    expect(all.items.find(item => item.company === 'Ferraço Joinville')).toMatchObject({ lastDispatch: { at: sentAt.toISOString(), campaign: 'Promo Chapa Preta' }, repliedAt: '2026-10-01T12:00:00.000Z' });
    expect((await service.page({ workspaceId, listId: first.listId, region: joinville, filter: 'never', page: 1, pageSize: 50 })).items.map(item => item.company))
      .toEqual(['3R Ferramentaria', 'Abrastech']);
    expect((await service.page({ workspaceId, listId: first.listId, region: null, filter: 'all', page: 1, pageSize: 50 })).items.map(item => item.company)).toEqual(['2 Rios']);
    const overview = await service.overview(workspaceId);
    expect(overview.regions.map(region => [region.region, region.total, region.dispatched])).toEqual([[joinville, 3, 1], ['Jaraguá e região', 1, 0], [null, 1, 0]]);

    // Joinville becomes this workspace's region: other regions are read only, here and on the server.
    await service.saveRegions(workspaceId, [
      { name: joinville, cities: ['Joinville', 'Araquari', 'Garuva'], seller: 'Henri', isMine: true },
      { name: 'Jaraguá e região', cities: ['Corupá', 'Jaraguá do Sul'], seller: 'Diogo', isMine: false }
    ]);
    expect((await service.page({ workspaceId, listId: first.listId, region: 'Jaraguá e região', filter: 'all', page: 1, pageSize: 50 })).selectable).toBe(false);
    await expect(service.selection({ workspaceId, listId: first.listId, region: 'Jaraguá e região', filter: 'all' })).rejects.toMatchObject({ code: 'LEAD_INVALID_TRANSITION' });
    const mine = await service.selection({ workspaceId, listId: first.listId, region: joinville, filter: 'never' });
    expect(mine.ids).toHaveLength(2);
    await expect(service.assertSelectable(workspaceId, first.listId, mine.ids)).resolves.toBeUndefined();
    const jaragua = (await db.lead.findMany({ where: { workspaceId, region: 'Jaraguá e região' } })).map(lead => lead.id);
    await expect(service.assertSelectable(workspaceId, first.listId, [...mine.ids, ...jaragua])).rejects.toMatchObject({ code: 'LEAD_INVALID_TRANSITION' });
    // Corupá with an accent still files "CORUPA".
    expect(jaragua).toHaveLength(1);
  });
});
