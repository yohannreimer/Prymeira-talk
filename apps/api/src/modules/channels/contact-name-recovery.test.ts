import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { RecentEvolutionContact } from '../evolution/evolution-history.js';
import { createContactNameRecovery } from './contact-name-recovery.js';

type Row = { id: string; workspaceId: string; phone: string; name: string | null; isGroup: boolean; updatedAt: Date };
type FindManyArgs = {
  where: { workspaceId: string; isGroup: boolean; name: { not: null }; id?: { gt: string } };
  select: Record<string, boolean>; orderBy: { id: 'asc' }; take: number;
};
type UpdateManyArgs = { where: { id: string; workspaceId: string; name: string }; data: { name: string | null; updatedAt: Date } };

const workspaceId = 'workspace-1';
const old = new Date('2026-05-01T10:00:00.000Z');
let sequence = 0;
const row = (phone: string, name: string | null, extra: Partial<Row> = {}): Row =>
  ({ id: `c-${String(++sequence).padStart(5, '0')}`, workspaceId, phone, name, isGroup: false, updatedAt: old, ...extra });

function fakePrisma(rows: Row[], options: { failWriteFor?: string; staleFor?: string } = {}) {
  const findMany = vi.fn(async (args: FindManyArgs) => rows
    .filter((item) => item.workspaceId === args.where.workspaceId && item.isGroup === args.where.isGroup && item.name !== null)
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
  it('only counts in a dry run and never writes', async () => {
    const rows = [row('5547999990001', 'Você'), row('5547999990002', '5547999990002'), row('5547999990003', 'Ana')];
    const { prisma, updateMany } = fakePrisma(rows);
    const source = fakeSource({ 'instance-a': [contact('5547999990001@s.whatsapp.net', 'Maria Souza')] });
    const result = await createContactNameRecovery({ prisma, source }).recover({ workspaceId, channels: [channelA], dryRun: true });
    expect(result).toEqual({ dryRun: true, channelsChecked: 1, invalid: 2, recoverable: 1, recovered: 0, cleared: 0, failedChannels: 0 });
    expect(updateMany).not.toHaveBeenCalled();
    expect(rows.map((item) => item.name)).toEqual(['Você', '5547999990002', 'Ana']);
  });

  it('restores real names with a conditional write that keeps updatedAt', async () => {
    const target = row('5547999990001', 'Você');
    const { prisma, updateMany } = fakePrisma([target]);
    const source = fakeSource({ 'instance-a': [contact('5547999990001@s.whatsapp.net', 'Maria Souza')] });
    const result = await createContactNameRecovery({ prisma, source }).recover({ workspaceId, channels: [channelA], dryRun: false });
    expect(result).toMatchObject({ dryRun: false, invalid: 1, recoverable: 1, recovered: 1, cleared: 0 });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: target.id, workspaceId, name: 'Você' },
      data: { name: 'Maria Souza', updatedAt: old }
    });
    expect(target.name).toBe('Maria Souza');
    expect(target.updatedAt).toBe(old);
  });

  it('clears an invalid name when no real name exists in Evolution', async () => {
    const target = row('5547999990009', '123456@lid');
    const { prisma, updateMany } = fakePrisma([target]);
    const source = fakeSource({ 'instance-a': [contact('5547999990001@s.whatsapp.net', 'Maria Souza'), contact('5547999990009@s.whatsapp.net', null)] });
    const result = await createContactNameRecovery({ prisma, source }).recover({ workspaceId, channels: [channelA], dryRun: false });
    expect(result).toMatchObject({ invalid: 1, recoverable: 0, recovered: 0, cleared: 1, failedChannels: 0 });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: target.id, workspaceId, name: '123456@lid' },
      data: { name: null, updatedAt: old }
    });
    expect(target.name).toBeNull();
  });

  it('keeps going when one channel fails and merges names from the others', async () => {
    const first = row('5547999990001', 'Você');
    const second = row('5547999990002', 'eu');
    const { prisma } = fakePrisma([first, second]);
    const source = fakeSource({
      'instance-a': new Error('HISTORY_HTTP_500'),
      'instance-b': [contact('5547999990001@s.whatsapp.net', 'Maria Souza')],
      'instance-c': [contact('5547999990001@s.whatsapp.net', 'Outro Nome'), contact('5547999990002@s.whatsapp.net', 'João')]
    });
    const result = await createContactNameRecovery({ prisma, source }).recover({
      workspaceId, channels: [channelA, channelB, { id: 'channel-c', providerKey: 'instance-c' }], dryRun: false
    });
    expect(source.recentContacts).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ dryRun: false, channelsChecked: 3, invalid: 2, recoverable: 2, recovered: 2, cleared: 0, failedChannels: 1 });
    expect(first.name).toBe('Maria Souza');
    expect(second.name).toBe('João');
  });

  it('never clears anything when every channel failed', async () => {
    const target = row('5547999990001', 'Você');
    const { prisma, updateMany } = fakePrisma([target]);
    const source = fakeSource({ 'instance-a': new Error('down'), 'instance-b': new Error('down') });
    const result = await createContactNameRecovery({ prisma, source }).recover({ workspaceId, channels: [channelA, channelB], dryRun: false });
    expect(result).toEqual({ dryRun: false, channelsChecked: 2, invalid: 1, recoverable: 0, recovered: 0, cleared: 0, failedChannels: 2 });
    expect(updateMany).not.toHaveBeenCalled();
    expect(target.name).toBe('Você');
  });

  it('does not count a contact whose name changed meanwhile or whose write failed', async () => {
    const stale = row('5547999990001', 'Você');
    const broken = row('5547999990002', 'Você');
    const fine = row('5547999990003', 'Você');
    const { prisma } = fakePrisma([stale, broken, fine], { staleFor: stale.id, failWriteFor: broken.id });
    const source = fakeSource({ 'instance-a': [
      contact('5547999990001@s.whatsapp.net', 'Maria'), contact('5547999990002@s.whatsapp.net', 'Pedro'), contact('5547999990003@s.whatsapp.net', 'Lia')
    ] });
    const result = await createContactNameRecovery({ prisma, source }).recover({ workspaceId, channels: [channelA], dryRun: false });
    expect(result).toMatchObject({ invalid: 3, recoverable: 3, recovered: 1, cleared: 0 });
    expect(fine.name).toBe('Lia');
  });

  it('matches LID identities and Brazilian numbers with or without the ninth digit', async () => {
    const lidContact = row('123456789012345@lid', 'Você');
    const twelve = row('554799990001', 'você');
    const thirteen = row('5547988880002', '+55 47 98888-0002');
    const { prisma } = fakePrisma([lidContact, twelve, thirteen]);
    const source = fakeSource({ 'instance-a': [
      contact('123456789012345@lid', 'Carla Lid'),
      contact('5547999990001@s.whatsapp.net', 'Bruno Treze'),
      contact('554788880002@s.whatsapp.net', 'Duda Doze')
    ] });
    const result = await createContactNameRecovery({ prisma, source }).recover({ workspaceId, channels: [channelA], dryRun: false });
    expect(result).toMatchObject({ invalid: 3, recoverable: 3, recovered: 3 });
    expect([lidContact.name, twelve.name, thirteen.name]).toEqual(['Carla Lid', 'Bruno Treze', 'Duda Doze']);
  });

  it('never touches usable names, groups or another workspace', async () => {
    const good = row('5547999990001', 'Ana Paula');
    const group = row('120363000000000000', 'Você', { isGroup: true });
    const foreign = row('5547999990003', 'Você', { workspaceId: 'workspace-2' });
    const { prisma, updateMany, findMany } = fakePrisma([good, group, foreign]);
    const source = fakeSource({ 'instance-a': [contact('5547999990001@s.whatsapp.net', 'Outro'), contact('5547999990003@s.whatsapp.net', 'Outro')] });
    const result = await createContactNameRecovery({ prisma, source }).recover({ workspaceId, channels: [channelA], dryRun: false });
    expect(result).toMatchObject({ invalid: 0, recoverable: 0, recovered: 0, cleared: 0 });
    expect(updateMany).not.toHaveBeenCalled();
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { workspaceId, isGroup: false, name: { not: null } },
      select: { id: true, phone: true, name: true, updatedAt: true }
    });
    expect([good.name, group.name, foreign.name]).toEqual(['Ana Paula', 'Você', 'Você']);
  });

  it('reads contacts in pages so large workspaces are processed in chunks', async () => {
    const rows = Array.from({ length: 4500 }, (_, index) => row(`55479${String(index).padStart(8, '0')}`, index % 2 ? 'Você' : `Pessoa ${index}`));
    const { prisma, findMany } = fakePrisma(rows);
    const source = fakeSource({ 'instance-a': [contact(`55479${String(4499).padStart(8, '0')}@s.whatsapp.net`, 'Último')] });
    const result = await createContactNameRecovery({ prisma, source }).recover({ workspaceId, channels: [channelA], dryRun: false });
    expect(findMany.mock.calls.length).toBeGreaterThan(2);
    for (const [args] of findMany.mock.calls) expect(args.take).toBeLessThanOrEqual(2000);
    expect(findMany.mock.calls[1]?.[0].where.id).toEqual({ gt: findMany.mock.results[0] && (await findMany.mock.results[0].value).at(-1).id });
    expect(result).toMatchObject({ invalid: 2250, recoverable: 1, recovered: 1, cleared: 2249 });
    expect(rows[4499]!.name).toBe('Último');
  });
});
