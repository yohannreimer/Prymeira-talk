import type { ChannelHealthDto, ChannelStatus, RealtimeEvent } from "@prymeira-talk/shared";
import { toChannelDto } from "./channels.service.js";
import { decideChannelHealth, MAX_RECONNECT_ATTEMPTS, type EvolutionState, type HealthMemory } from "./channel-health.js";

const DEFAULT_INTERVAL_MS = 120_000;
const WEBHOOK_EVERY_MS = 15 * 60_000;
const DORMANT_AFTER_MS = 7 * 24 * 60 * 60_000;

type ChannelRow = {
  id: string; workspaceId: string; provider: string; providerKey: string;
  phoneNumber: string | null; displayName: string | null; status: ChannelStatus;
  createdAt: Date; updatedAt: Date;
};

export interface ChannelWatchdogPrisma {
  channel: {
    findMany(args: { where: { provider: "evolution" } }): Promise<ChannelRow[]>;
    update(args: { where: { workspaceId_id: { workspaceId: string; id: string } }; data: { status: ChannelStatus } }): Promise<ChannelRow>;
  };
  message: {
    findFirst(args: {
      where: { workspaceId: string; direction: "inbound"; conversation: { channelId: string } };
      orderBy: { createdAt: "desc" };
      select: { createdAt: true };
    }): Promise<{ createdAt: Date } | null>;
    findFirst(args: {
      where: { workspaceId: string; conversation: { channelId: string }; createdAt: { gte: Date } };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
}

export interface ChannelWatchdogEvolution {
  client: {
    getConnectionState?(input: { instanceName: string }): Promise<EvolutionState>;
    connectInstance(input: { instanceName: string }): Promise<{ qrCode: string | null }>;
    setWebhook(input: { instanceName: string; webhookUrl: string; webhookSecret: string }): Promise<unknown>;
  };
  webhookSecret: string;
  publicWebhookUrl(workspaceId: string): string;
}

type Logger = { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };

export function createChannelWatchdog(deps: {
  prisma: ChannelWatchdogPrisma;
  evolution: ChannelWatchdogEvolution;
  publish: (event: RealtimeEvent) => void;
  now?: () => Date;
  intervalMs?: number;
  log?: Logger;
}) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? console;
  const memory = new Map<string, HealthMemory & { workspaceId: string; lastInboundAt: string | null }>();
  const webhookAt = new Map<string, number>();
  const manualDisconnects = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  const toDto = (channelId: string, entry: NonNullable<ReturnType<typeof memory.get>>): ChannelHealthDto => ({
    channelId, state: entry.state, since: entry.since, lastInboundAt: entry.lastInboundAt, attempts: entry.attempts
  });

  async function check(channel: ChannelRow) {
    const client = deps.evolution.client;
    if (!client.getConnectionState) return;
    const evolutionState = await client.getConnectionState({ instanceName: channel.providerKey }).catch(() => null);
    const previous = memory.get(channel.id) ?? null;
    const current = now();

    let lastInboundAt: Date | null = null;
    if (evolutionState === "open") {
      const last = await deps.prisma.message.findFirst({
        where: { workspaceId: channel.workspaceId, direction: "inbound", conversation: { channelId: channel.id } },
        orderBy: { createdAt: "desc" }, select: { createdAt: true }
      });
      lastInboundAt = last?.createdAt ?? null;
    }

    let decision = decideChannelHealth({ evolutionState, previous, lastInboundAt, now: current });

    // Manually disconnected or dormant channels are still reconciled, but never reconnected or alerted.
    const suppressed = evolutionState !== null && (manualDisconnects.has(channel.id) || !(await deps.prisma.message.findFirst({
      where: { workspaceId: channel.workspaceId, conversation: { channelId: channel.id }, createdAt: { gte: new Date(current.getTime() - DORMANT_AFTER_MS) } },
      select: { id: true }
    })));
    if (suppressed) {
      decision = {
        ...decision, state: "ok", attempts: 0, nextAttemptAt: null, action: "none",
        since: previous?.state === "ok" ? previous.since : current.toISOString()
      };
    }

    if (decision.talkStatus && decision.talkStatus !== channel.status) {
      const updated = await deps.prisma.channel.update({
        where: { workspaceId_id: { workspaceId: channel.workspaceId, id: channel.id } },
        data: { status: decision.talkStatus }
      });
      deps.publish({ type: "channel.updated", workspaceId: channel.workspaceId, payload: toChannelDto(updated as never) });
    }

    if (!suppressed && evolutionState === "open" && (current.getTime() - (webhookAt.get(channel.id) ?? 0)) >= WEBHOOK_EVERY_MS) {
      webhookAt.set(channel.id, current.getTime());
      await client.setWebhook({
        instanceName: channel.providerKey,
        webhookUrl: deps.evolution.publicWebhookUrl(channel.workspaceId),
        webhookSecret: deps.evolution.webhookSecret
      }).catch((error: unknown) => log.warn({ err: error, channelId: channel.id }, "Channel watchdog could not reassert the webhook."));
    }

    if (decision.action === "reconnect") {
      const result = await client.connectInstance({ instanceName: channel.providerKey })
        .catch((error: unknown) => { log.warn({ err: error, channelId: channel.id }, "Channel watchdog reconnect attempt failed."); return null; });
      if (result?.qrCode) {
        decision = { ...decision, state: "needs_qr", attempts: MAX_RECONNECT_ATTEMPTS, nextAttemptAt: null, since: previous?.state === "needs_qr" ? previous.since : current.toISOString() };
      }
      log.info({ channelId: channel.id, attempt: decision.attempts, needsQr: Boolean(result?.qrCode) }, "Channel watchdog reconnect attempted.");
    }

    const next = {
      workspaceId: channel.workspaceId, state: decision.state, since: decision.since,
      attempts: decision.attempts, nextAttemptAt: decision.nextAttemptAt,
      lastInboundAt: lastInboundAt ? lastInboundAt.toISOString() : previous?.lastInboundAt ?? null
    };
    memory.set(channel.id, next);
    const changed = !previous ? decision.state !== "ok" : previous.state !== decision.state;
    if (changed) deps.publish({ type: "channel.health", workspaceId: channel.workspaceId, payload: toDto(channel.id, next) });
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const channels = await deps.prisma.channel.findMany({ where: { provider: "evolution" } });
      for (const channel of channels) {
        await check(channel).catch((error: unknown) => log.error({ err: error, channelId: channel.id }, "Channel watchdog check failed."));
      }
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
      timer.unref?.();
    },
    markManualDisconnect(channelId: string) { manualDisconnects.add(channelId); },
    clearManualDisconnect(channelId: string) { manualDisconnects.delete(channelId); },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    getHealth(workspaceId: string): ChannelHealthDto[] {
      return [...memory.entries()]
        .filter(([, entry]) => entry.workspaceId === workspaceId)
        .map(([channelId, entry]) => toDto(channelId, entry));
    }
  };
}
