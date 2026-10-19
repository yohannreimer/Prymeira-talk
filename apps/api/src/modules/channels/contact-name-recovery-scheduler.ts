import type { PrismaClient } from '@prisma/client';
import type { EvolutionHistorySource } from '../evolution/evolution-history.js';
import { createContactNameRecovery, type ContactNameRecoveryResult } from './contact-name-recovery.js';

/** First run waits until the API is fully up and the Evolution connection is warm. */
export const CONTACT_NAME_RECOVERY_INITIAL_DELAY_MS = 2 * 60_000;
export const CONTACT_NAME_RECOVERY_INTERVAL_MS = 6 * 60 * 60_000;

type SchedulerInput = {
  prisma: Pick<PrismaClient, 'channel' | 'contact'>;
  source: Pick<EvolutionHistorySource, 'recentContacts'>;
  intervalMs?: number;
  initialDelayMs?: number;
  onResult?: (workspaceId: string, result: ContactNameRecoveryResult) => void;
  onError?: (error: unknown, workspaceId?: string) => void;
};

/** Periodically restores real contact names in every workspace with a connected Evolution channel. */
export function createContactNameRecoveryScheduler(input: SchedulerInput) {
  const recovery = createContactNameRecovery(input);
  let initialTimer: NodeJS.Timeout | null = null;
  let timer: NodeJS.Timeout | null = null;
  let active: Promise<void> | null = null;
  let stopping = false;

  async function tick() {
    if (stopping) return;
    const channels = await input.prisma.channel.findMany({
      where: { provider: 'evolution', status: 'connected' },
      select: { id: true, workspaceId: true, providerKey: true },
      orderBy: [{ workspaceId: 'asc' }, { id: 'asc' }]
    });
    const byWorkspace = new Map<string, Array<{ id: string; providerKey: string }>>();
    for (const channel of channels) {
      const list = byWorkspace.get(channel.workspaceId) ?? [];
      list.push({ id: channel.id, providerKey: channel.providerKey });
      byWorkspace.set(channel.workspaceId, list);
    }
    for (const [workspaceId, workspaceChannels] of byWorkspace) {
      if (stopping) return;
      try {
        const result = await recovery.recover({ workspaceId, channels: workspaceChannels, dryRun: false });
        input.onResult?.(workspaceId, result);
      } catch (error) {
        input.onError?.(error, workspaceId);
      }
    }
  }
  function poll() {
    if (active) return;
    active = tick().catch((error) => { input.onError?.(error); }).finally(() => { active = null; });
  }
  return {
    start() {
      if (initialTimer || timer) return;
      stopping = false;
      initialTimer = setTimeout(() => {
        initialTimer = null;
        poll();
        timer = setInterval(poll, input.intervalMs ?? CONTACT_NAME_RECOVERY_INTERVAL_MS);
        timer.unref?.();
      }, input.initialDelayMs ?? CONTACT_NAME_RECOVERY_INITIAL_DELAY_MS);
      initialTimer.unref?.();
    },
    async stop() {
      stopping = true;
      if (initialTimer) clearTimeout(initialTimer);
      if (timer) clearInterval(timer);
      initialTimer = null;
      timer = null;
      await active;
    },
    runOnce: tick
  };
}

/** The app starts the job only with a database, an Evolution history source and the kill switch on. */
export function createContactNameRecoverySchedulerIfEnabled(
  input: Omit<SchedulerInput, 'prisma' | 'source'> & {
    enabled: boolean;
    prisma: SchedulerInput['prisma'] | undefined;
    source: SchedulerInput['source'] | undefined;
  }
) {
  const { enabled, prisma, source, ...options } = input;
  if (!enabled || !prisma || !source) return undefined;
  return createContactNameRecoveryScheduler({ ...options, prisma, source });
}
