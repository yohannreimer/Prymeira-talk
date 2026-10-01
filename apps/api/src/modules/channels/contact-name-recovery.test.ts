import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { RecentEvolutionContact } from '../evolution/evolution-history.js';
import { createContactNameRecovery } from './contact-name-recovery.js';

type Row = { id: string; workspaceId: string; phone: string; name: string | null; isGroup: boolean; updatedAt: Date };
type FindManyArgs = {
  where: { workspaceId: string; isGroup: boolean; id?: { gt: string } };
  select: Record<string, boolean>; orderBy: { id: 'asc' }; take: number;
};
type UpdateManyArgs = { where: { id: string; workspaceId: string; name: string | null }; data: { name: string | null; updatedAt: Date } };

const workspaceId = 'workspace-1';
const old = new Date('2026-05-01T10:00:00.000Z');
let sequence = 0;
const row = (phone: string, name: string | null, extra: Partial<Row> = {}): Row =>
  ({ id: `c-${String(++sequence).padStart(5, '0')}`, workspaceId, phone, name, isGroup: false, updatedAt: old, ...extra });

function fakePrisma(rows: Row[], options: { failWriteFor?: string; staleFor?: string } = {}) {
  const findMany = vi.fn(async (args: FindManyArgs) => rows
    .filter((item) => item.workspaceId === args.where.workspaceId && item.isGroup === args.where.isGroup)
    .filter((item) => !args.where.id || item.id > args.where.id.gt)
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, args.take)
    .map((item) => ({ id: item.id, phone: item.phone, name: item.name, updatedAt: item.updatedAt })));
  const updateMany = vi.fn(async (args: UpdateManyArgs) => {
    if (args.where.id === options.failWriteFor) throw new Error('db down');
    const target = rows.find((item) => item.id === args.where.id && item.workspaceId === args.where.workspaceId && item.name === args.where.name);
    if (!target || target.id === options.staleFor) return { count: 0 };
    target.name = args.data.name;
    target.updatedAt = args.data.updatedAt;
    return { count: 1 };
  });
  return { prisma: { contact: { findMany, updateMany } } as unknown as PrismaClient, findMany, updateMany };
}

const contact = (jid: string, name: string | null): RecentEvolutionContact => ({ phoneJid: jid, name, profilePicUrl: null });
function fakeSource(byInstance: Record<string, RecentEvolutionContact[] | Error>) {
  return {
    recentContacts: vi.fn(async ({ instanceName }: { instanceName: string }) => {
      const value = byInstance[instanceName];
      if (value instanceof Error) throw value;
      return value ?? [];
    })
  };
}
const channelA = { id: 'channel-a', providerKey: 'instance-a' };
const channelB = { id: 'channel-b', providerKey: 'instance-b' };

describe('contact name recovery', () => {
  it('gives a null-named contact its real name', async () => {
    const target = row('5547999990001', null);
    const { prisma, updateMany } = fakePrisma([target]);
    const source = fakeSource({ 'instance-a': [contact('5547999990001@s.whatsapp.net', 'Maria Souza')] });
    const result = await createContactNameRecovery({ prisma, source }).recover({ workspaceId, channels: [channelA] });
    expect(result).toEqual({ dryRun: false, channelsChecked: 1, failedChannels: 0, candidates: 1, recovered: 1, cleared: 0, skipped: 0 });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: target.id, workspaceId, name: null },
      data: { name: 'Maria Souza', updatedAt: old }
    });
    expect(target.name).toBe('Maria Souza');
  });

  it('restores invalid names with a conditional write that keeps updatedAt', async () => {
    const voce = row('5547999990001', 'Você');
    const number = row('5547999990002', '+55 47 99999-0002');
    const lidName = row('5547999990003', '123456@lid');
    const { prisma, updateMany } = fakePrisma([voce, number, lidName]);
    const source = fakeSource({ 'instance-a': [
      contact('5547999990001@s.whatsapp.net', 'Maria Souza'),
      contact('5547999990002@s.whatsapp.net', 'Pedro'),
      contact('5547999990003@s.whatsapp.net', 'Lia')
    ] });
    const result = await createContactNameRecovery({ prisma, source }).recover({ workspaceId, channels: [channelA], dryRun: false });
    expect(result).toMatchObject({ candidates: 3, recovered: 3, cleared: 0, skipped: 0 });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: voce.id, workspaceId, name: 'Você' },
      data: { name: 'Maria Souza', updatedAt: old }
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: number.id, workspaceId, name: '+55 47 99999-0002' },
      data: { name: 'Pedro', updatedAt: old }
    });
    expect([voce.name, number.name, lidName.name]).toEqual(['Maria Souza', 'Pedro', 'Lia']);
    expect(voce.updatedAt).toBe(old);
  });

  it('clears an invalid name when Evolution has no real name, and skips a null name', async () => {
    const invalid = row('5547999990009', '123456@lid');
    const empty = row('5547999990008', null);
    const { prisma, updateMany } = fakePrisma([invalid, empty]);
    const source = fakeSource({ 'instance-a': [contact('5547999990001@s.whatsapp.net', 'Maria Souza'), contact('5547999990009@s.whatsapp.net', 'Você')] });
    const result = await createContactNameRecovery({ prisma, source }).recover({ workspaceId, channels: [channelA] });
    expect(result).toEqual({ dryRun: false, channelsChecked: 1, failedChannels: 0, candidates: 2, recovered: 0, cleared: 1, skipped: 1 });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: invalid.id, workspaceId, name: '123456@lid' },
      data: { name: null, updatedAt: old }
    });
    expect(invalid.name).toBeNull();
    expect(empty.name).toBeNull();
  });

  it('recovers a previously cleared contact on a later run', async () => {
    const target = row('5547999990001', 'Você');
    const { prisma } = fakePrisma([target]);
    const recovery = createContactNameRecovery({ prisma, source: fakeSource({ 'instance-a': [] }) });
    expect(await recovery.recover({ workspaceId, channels: [channelA] })).toMatchObject({ cleared: 1 });
    const later = createContactNameRecovery({ prisma, source: fakeSource({ 'instance-a': [contact('5547999990001@s.whatsapp.net', 'Maria')] }) });
    expect(await later.recover({ workspaceId, channels: [channelA] })).toMatchObject({ candidates: 1, recovered: 1 });
    expect(target.name).toBe('Maria');
  });

  it('only counts in a dry run and never writes', async () => {
    const rows = [row('5547999990001', 'Você'), row('5547999990002', '5547999990002'), row('5547999990003', null), row('5547999990004', 'Ana')];
    const { prisma, updateMany } = fakePrisma(rows);
    const source = fakeSource({ 'instance-a': [contact('5547999990001@s.whatsapp.net', 'Maria Souza')] });
    const result = await createContactNameRecovery({ prisma, source }).recover({ workspaceId, channels: [channelA], dryRun: true });
    expect(result).toEqual({ dryRun: true, channelsChecked: 1, failedChannels: 0, candidates: 3, recovered: 1, cleared: 1, skipped: 1 });
    expect(updateMany).not.toHaveBeenCalled();
    expect(rows.map((item) => item.name)).toEqual(['Você', '5547999990002', null, 'Ana']);
  });

  it('keeps going when one channel fails and merges names (first usable name wins)', async () => {
    const first = row('5547999990001', 'Você');
    const second = row('5547999990002', null);
    const { prisma } = fakePrisma([first, second]);
    const source = fakeSource({
      'instance-a': new Error('HISTORY_HTTP_500'),
      'instance-b': [contact('5547999990001@s.whatsapp.net', 'Maria Souza'), contact('5547999990002@s.whatsapp.net', 'Você')],
      'instance-c': [contact('5547999990001@s.whatsapp.net', 'Outro Nome'), contact('5547999990002@s.whatsapp.net', 'João')]
    });
    const result = await createContactNameRecovery({ prisma, source }).recover({
      workspaceId, channels: [channelA, channelB, { id: 'channel-c', providerKey: 'instance-c' }]
    });
    expect(source.recentContacts).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ dryRun: false, channelsChecked: 3, failedChannels: 1, candidates: 2, recovered: 2, cleared: 0, skipped: 0 });
    expect(first.name).toBe('Maria Souza');
    expect(second.name).toBe('João');
  });

  it('writes nothing at all when every channel failed', async () => {
    const target = row('5547999990001', 'Você');
    const empty = row('5547999990002', null);
    const { prisma, updateMany } = fakePrisma([target, empty]);
    const source = fakeSource({ 'instance-a': new Error('down'), 'instance-b': new Error('down') });
    const result = await createContactNameRecovery({ prisma, source }).recover({ workspaceId, channels: [channelA, channelB] });
    expect(result).toMatchObject({ dryRun: false, channelsChecked: 2, failedChannels: 2, recovered: 0, cleared: 0 });
    expect(updateMany).not.toHaveBeenCalled();
    expect(target.name).toBe('Você');
  });

  it('writes nothing when there is no channel to ask', async () => {
    const target = row('5547999990001', 'Você');
    const { prisma, updateMany } = fakePrisma([target]);
    const result = await createContactNameRecovery({ prisma, source: fakeSource({}) }).recover({ workspaceId, channels: [] });
    expect(result).toMatchObject({ channelsChecked: 0, failedChannels: 0, recovered: 0, cleared: 0 });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('counts a stale or failed write as skipped instead of throwing', async () => {
    const stale = row('5547999990001', 'Você');
    const broken = row('5547999990002', 'Você');
    const fine = row('5547999990003', 'Você');
    const { prisma } = fakePrisma([stale, broken, fine], { staleFor: stale.id, failWriteFor: broken.id });
    const source = fakeSource({ 'instance-a': [
      contact('5547999990001@s.whatsapp.net', 'Maria'), contact('5547999990002@s.whatsapp.net', 'Pedro'), contact('5547999990003@s.whatsapp.net', 'Lia')
    ] });
    const result = await createContactNameRecovery({ prisma, source }).recover({ workspaceId, channels: [channelA] });
    expect(result).toMatchObject({ candidates: 3, recovered: 1, cleared: 0, skipped: 2 });
    expect(stale.name).toBe('Você');
    expect(fine.name).toBe('Lia');
  });

  it('matches LID identities and Brazilian numbers with or without the ninth digit', async () => {
    const lidContact = row('123456789012345@lid', 'Você');
    const twelve = row('554799990001', 'você');
    const thirteen = row('5547988880002', null);
    const { prisma } = fakePrisma([lidContact, twelve, thirteen]);
    const source = fakeSource({ 'instance-a': [
      contact('123456789012345@lid', 'Carla Lid'),
      contact('5547999990001@s.whatsapp.net', 'Bruno Treze'),
      contact('554788880002@s.whatsapp.net', 'Duda Doze')
    ] });
    const result = await createContactNameRecovery({ prisma, source }).recover({ workspaceId, channels: [channelA] });
    expect(result).toMatchObject({ candidates: 3, recovered: 3 });
    expect([lidContact.name, twelve.name, thirteen.name]).toEqual(['Carla Lid', 'Bruno Treze', 'Duda Doze']);
  });

  it('never touches usable names, groups or another workspace', async () => {
    const good = row('5547999990001', 'Ana Paula');
    const padded = row('5547999990004', '  Zé  ');
    const group = row('120363000000000000', 'Você', { isGroup: true });
    const foreign = row('5547999990003', 'Você', { workspaceId: 'workspace-2' });
    const { prisma, updateMany, findMany } = fakePrisma([good, padded, group, foreign]);
    const source = fakeSource({ 'instance-a': [
      contact('5547999990001@s.whatsapp.net', 'Outro'), contact('5547999990004@s.whatsapp.net', 'Outro'), contact('5547999990003@s.whatsapp.net', 'Outro')
    ] });
    const result = await createContactNameRecovery({ prisma, source }).recover({ workspaceId, channels: [channelA] });
    expect(result).toMatchObject({ candidates: 0, recovered: 0, cleared: 0, skipped: 0 });
    expect(updateMany).not.toHaveBeenCalled();
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { workspaceId, isGroup: false },
      select: { id: true, phone: true, name: true, updatedAt: true }
    });
    expect([good.name, padded.name, group.name, foreign.name]).toEqual(['Ana Paula', '  Zé  ', 'Você', 'Você']);
  });

  it('reads contacts in pages of at most 2000 using an id cursor', async () => {
    const rows = Array.from({ length: 4500 }, (_, index) => row(`55479${String(index).padStart(8, '0')}`, index % 2 ? 'Você' : `Pessoa ${index}`));
    const { prisma, findMany } = fakePrisma(rows);
    const source = fakeSource({ 'instance-a': [contact(`55479${String(4499).padStart(8, '0')}@s.whatsapp.net`, 'Último')] });
    const result = await createContactNameRecovery({ prisma, source }).recover({ workspaceId, channels: [channelA] });
    expect(findMany).toHaveBeenCalledTimes(3);
    for (const [args] of findMany.mock.calls) {
      expect(args.take).toBe(2000);
      expect(args.orderBy).toEqual({ id: 'asc' });
    }
    expect(findMany.mock.calls[0]?.[0].where.id).toBeUndefined();
    expect(findMany.mock.calls[1]?.[0].where.id).toEqual({ gt: rows[1999]!.id });
    expect(findMany.mock.calls[2]?.[0].where.id).toEqual({ gt: rows[3999]!.id });
    expect(result).toMatchObject({ candidates: 2250, recovered: 1, cleared: 2249, skipped: 0 });
    expect(rows[4499]!.name).toBe('Último');
    expect(rows[4498]!.name).toBe('Pessoa 4498');
  });
});
