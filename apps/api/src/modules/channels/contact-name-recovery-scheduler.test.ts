import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  CONTACT_NAME_RECOVERY_INITIAL_DELAY_MS,
  CONTACT_NAME_RECOVERY_INTERVAL_MS,
  createContactNameRecoveryScheduler,
  createContactNameRecoverySchedulerIfEnabled
} from './contact-name-recovery-scheduler.js';

type Contact = { id: string; workspaceId: string; phone: string; name: string | null; isGroup: boolean; updatedAt: Date };
const updatedAt = new Date('2026-05-01T10:00:00.000Z');

function fakePrisma(input: {
  channels: Array<{ id: string; workspaceId: string; providerKey: string }>;
  contacts: Contact[];
  failContactsFor?: string;
}) {
  const channelFindMany = vi.fn(async () => input.channels);
  const contactFindMany = vi.fn(async (args: { where: { workspaceId: string; id?: { gt: string } } }) => {
    if (args.where.workspaceId === input.failContactsFor) throw new Error('db down');
    return args.where.id ? [] : input.contacts.filter((item) => item.workspaceId === args.where.workspaceId && !item.isGroup);
  });
  const updateMany = vi.fn(async (args: { where: { id: string; name: string | null }; data: { name: string | null } }) => {
    const target = input.contacts.find((item) => item.id === args.where.id && item.name === args.where.name);
    if (!target) return { count: 0 };
    target.name = args.data.name;
    return { count: 1 };
  });
  return {
    prisma: { channel: { findMany: channelFindMany }, contact: { findMany: contactFindMany, updateMany } } as unknown as PrismaClient,
    channelFindMany, contactFindMany, updateMany
  };
}

const source = (names: Record<string, string>) => ({
  recentContacts: vi.fn(async (_input: { instanceName: string }) => Object.entries(names).map(([phone, name]) => ({ phoneJid: `${phone}@s.whatsapp.net`, name, profilePicUrl: null })))
});

describe('contact name recovery scheduler', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('defaults to a first run two minutes after start and then every six hours', () => {
    expect(CONTACT_NAME_RECOVERY_INITIAL_DELAY_MS).toBe(2 * 60_000);
    expect(CONTACT_NAME_RECOVERY_INTERVAL_MS).toBe(6 * 60 * 60_000);
  });

  it('loads connected Evolution channels of every workspace and recovers each workspace in turn', async () => {
    const contacts: Contact[] = [
      { id: 'c-1', workspaceId: 'w-1', phone: '5547999990001', name: 'Você', isGroup: false, updatedAt },
      { id: 'c-2', workspaceId: 'w-2', phone: '5547999990002', name: null, isGroup: false, updatedAt }
    ];
    const { prisma, channelFindMany } = fakePrisma({ contacts, channels: [
      { id: 'ch-1', workspaceId: 'w-1', providerKey: 'inst-1' },
      { id: 'ch-2', workspaceId: 'w-2', providerKey: 'inst-2' },
      { id: 'ch-3', workspaceId: 'w-1', providerKey: 'inst-3' }
    ] });
    const evolution = source({ '5547999990001': 'Maria', '5547999990002': 'João' });
    const onResult = vi.fn();
    const scheduler = createContactNameRecoveryScheduler({ prisma, source: evolution, onResult });
    await scheduler.runOnce();
    expect(channelFindMany).toHaveBeenCalledWith({
      where: { provider: 'evolution', status: 'connected' },
      select: { id: true, workspaceId: true, providerKey: true },
      orderBy: [{ workspaceId: 'asc' }, { id: 'asc' }]
    });
    expect(evolution.recentContacts.mock.calls.map(([args]) => args)).toEqual([
      { instanceName: 'inst-1' }, { instanceName: 'inst-3' }, { instanceName: 'inst-2' }
    ]);
    expect(onResult).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenNthCalledWith(1, 'w-1', expect.objectContaining({ dryRun: false, channelsChecked: 2, recovered: 1 }));
    expect(onResult).toHaveBeenNthCalledWith(2, 'w-2', expect.objectContaining({ dryRun: false, channelsChecked: 1, recovered: 1 }));
    expect(contacts.map((item) => item.name)).toEqual(['Maria', 'João']);
  });

  it('still repairs names when no onResult callback is given', async () => {
    const contacts: Contact[] = [{ id: 'c-1', workspaceId: 'w-1', phone: '5547999990001', name: 'Você', isGroup: false, updatedAt }];
    const { prisma } = fakePrisma({ contacts, channels: [{ id: 'ch-1', workspaceId: 'w-1', providerKey: 'inst-1' }] });
    await createContactNameRecoveryScheduler({ prisma, source: source({ '5547999990001': 'Maria' }) }).runOnce();
    expect(contacts[0]!.name).toBe('Maria');
  });

  it('keeps going with the next workspace when one fails', async () => {
    const contacts: Contact[] = [{ id: 'c-2', workspaceId: 'w-2', phone: '5547999990002', name: 'Você', isGroup: false, updatedAt }];
    const { prisma } = fakePrisma({ contacts, failContactsFor: 'w-1', channels: [
      { id: 'ch-1', workspaceId: 'w-1', providerKey: 'inst-1' },
      { id: 'ch-2', workspaceId: 'w-2', providerKey: 'inst-2' }
    ] });
    const onResult = vi.fn();
    const onError = vi.fn();
    const scheduler = createContactNameRecoveryScheduler({ prisma, source: source({ '5547999990002': 'João' }), onResult, onError });
    await scheduler.runOnce();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'w-1');
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith('w-2', expect.objectContaining({ recovered: 1 }));
    expect(contacts[0]!.name).toBe('João');
  });

  it('reports a failure to load channels through onError without throwing', async () => {
    const prisma = { channel: { findMany: vi.fn().mockRejectedValue(new Error('db down')) }, contact: {} } as unknown as PrismaClient;
    const onError = vi.fn();
    const scheduler = createContactNameRecoveryScheduler({ prisma, source: source({}), onError, initialDelayMs: 10 });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    await scheduler.stop();
  });

  it('waits for the initial delay, repeats on the interval and stops cleanly', async () => {
    const { prisma, channelFindMany } = fakePrisma({ contacts: [], channels: [] });
    const scheduler = createContactNameRecoveryScheduler({ prisma, source: source({}), initialDelayMs: 1_000, intervalMs: 5_000 });
    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(channelFindMany).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(channelFindMany).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(channelFindMany).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(channelFindMany).toHaveBeenCalledTimes(3);
    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(channelFindMany).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not run when stopped before the initial delay', async () => {
    const { prisma, channelFindMany } = fakePrisma({ contacts: [], channels: [] });
    const scheduler = createContactNameRecoveryScheduler({ prisma, source: source({}) });
    scheduler.start();
    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(CONTACT_NAME_RECOVERY_INTERVAL_MS * 2);
    expect(channelFindMany).not.toHaveBeenCalled();
  });

  it('never overlaps a tick that is still running and stop waits for it', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const { prisma } = fakePrisma({ contacts: [], channels: [{ id: 'ch-1', workspaceId: 'w-1', providerKey: 'inst-1' }] });
    const slowSource = { recentContacts: vi.fn(async () => { await pending; return []; }) };
    const channelFindMany = vi.mocked(prisma.channel.findMany);
    const onResult = vi.fn();
    const scheduler = createContactNameRecoveryScheduler({ prisma, source: slowSource, initialDelayMs: 10, intervalMs: 100, onResult });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(500);
    expect(channelFindMany).toHaveBeenCalledTimes(1);
    expect(slowSource.recentContacts).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = scheduler.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('stops between workspaces once stop was requested', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const { prisma } = fakePrisma({ contacts: [], channels: [
      { id: 'ch-1', workspaceId: 'w-1', providerKey: 'inst-1' },
      { id: 'ch-2', workspaceId: 'w-2', providerKey: 'inst-2' }
    ] });
    const slowSource = { recentContacts: vi.fn(async () => { await pending; return []; }) };
    const scheduler = createContactNameRecoveryScheduler({ prisma, source: slowSource, initialDelayMs: 10, intervalMs: 10 });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(100);
    expect(slowSource.recentContacts).toHaveBeenCalledTimes(1);
    const stopping = scheduler.stop();
    release();
    await stopping;
    expect(slowSource.recentContacts).toHaveBeenCalledTimes(1);
  });
});

describe('createContactNameRecoverySchedulerIfEnabled', () => {
  const { prisma } = fakePrisma({ contacts: [], channels: [] });
  const evolution = source({});

  it('creates a scheduler when enabled with a database and an Evolution history source', () => {
    expect(createContactNameRecoverySchedulerIfEnabled({ enabled: true, prisma, source: evolution })).toBeDefined();
  });

  it('does not create a scheduler when the kill switch is off', () => {
    expect(createContactNameRecoverySchedulerIfEnabled({ enabled: false, prisma, source: evolution })).toBeUndefined();
  });

  it('does not create a scheduler without an Evolution history source or database', () => {
    expect(createContactNameRecoverySchedulerIfEnabled({ enabled: true, prisma, source: undefined })).toBeUndefined();
    expect(createContactNameRecoverySchedulerIfEnabled({ enabled: true, prisma: undefined, source: evolution })).toBeUndefined();
  });
});
