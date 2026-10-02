import type { ChannelHealthDto, ChannelStatus, RealtimeEvent } from "@prymeira-talk/shared";
import { toChannelDto } from "./channels.service.js";
import { decideChannelHealth, MAX_RECONNECT_ATTEMPTS, type EvolutionState, type HealthMemory } from "./channel-health.js";

const DEFAULT_INTERVAL_MS = 120_000;
const WEBHOOK_EVERY_MS = 15 * 60_000;
const DORMANT_AFTER_MS = 7 * 24 * 60 * 60_000;
const UNREACHABLE_LOG_EVERY_MS = 10 * 60_000;
const UNREACHABLE_TICKS = 3;

type CheckOutcome = "skipped" | "unreachable" | "answered";

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
  dryRun?: boolean;
  log?: Logger;
}) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? console;
  const dryRun = deps.dryRun === true;
  const unreachableLoggedAt = new Map<string, number>();
  let lastTickAt: string | null = null;
  let lastTickOk = true;
  let lastError: string | null = null;
  let unreachableTicks = 0;
  const memory = new Map<string, HealthMemory & { workspaceId: string; lastInboundAt: string | null }>();
  const webhookAt = new Map<string, number>();
  const manualDisconnects = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  const toDto = (channelId: string, entry: NonNullable<ReturnType<typeof memory.get>>): ChannelHealthDto => ({
    channelId, state: entry.state, since: entry.since, lastInboundAt: entry.lastInboundAt, attempts: entry.attempts
  });

  async function check(channel: ChannelRow): Promise<CheckOutcome> {
    const client = deps.evolution.client;
    if (!client.getConnectionState) return "skipped";
    const current = now();
    const evolutionState = await client.getConnectionState({ instanceName: channel.providerKey }).catch((error: unknown) => {
      const lastLogged = unreachableLoggedAt.get(channel.id);
      if (lastLogged === undefined || current.getTime() - lastLogged >= UNREACHABLE_LOG_EVERY_MS) {
        unreachableLoggedAt.set(channel.id, current.getTime());
        log.warn({
          event: "channel_watchdog_evolution_unreachable", channelId: channel.id,
          err: error instanceof Error ? error.message : String(error)
        }, "Channel watchdog could not reach Evolution.");
      }
      return null;
    });
    const previous = memory.get(channel.id) ?? null;

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
      if (dryRun) {
        log.info({ event: "channel_watchdog_dry_run", action: "update_status", channelId: channel.id, from: channel.status, to: decision.talkStatus }, "Channel watchdog dry run: would update the channel status.");
      } else {
        const from = channel.status;
        const updated = await deps.prisma.channel.update({
          where: { workspaceId_id: { workspaceId: channel.workspaceId, id: channel.id } },
          data: { status: decision.talkStatus }
        });
        deps.publish({ type: "channel.updated", workspaceId: channel.workspaceId, payload: toChannelDto(updated as never) });
        log.info({ event: "channel_watchdog_status_corrected", channelId: channel.id, from, to: decision.talkStatus }, "Channel watchdog corrected the channel status.");
      }
    }

    if (!suppressed && evolutionState === "open" && (current.getTime() - (webhookAt.get(channel.id) ?? 0)) >= WEBHOOK_EVERY_MS) {
      webhookAt.set(channel.id, current.getTime());
      if (dryRun) {
        log.info({ event: "channel_watchdog_dry_run", action: "reassert_webhook", channelId: channel.id, instanceName: channel.providerKey }, "Channel watchdog dry run: would reassert the webhook.");
      } else {
        await client.setWebhook({
          instanceName: channel.providerKey,
          webhookUrl: deps.evolution.publicWebhookUrl(channel.workspaceId),
          webhookSecret: deps.evolution.webhookSecret
        }).catch((error: unknown) => log.warn({ event: "channel_watchdog_webhook_failed", err: error, channelId: channel.id }, "Channel watchdog could not reassert the webhook."));
      }
    }

    if (decision.action === "reconnect") {
      if (dryRun) {
        log.info({ event: "channel_watchdog_dry_run", action: "reconnect", channelId: channel.id, attempt: decision.attempts }, "Channel watchdog dry run: would attempt a reconnect.");
      } else {
        const result = await client.connectInstance({ instanceName: channel.providerKey })
          .catch((error: unknown) => { log.warn({ event: "channel_watchdog_reconnect_failed", err: error, channelId: channel.id }, "Channel watchdog reconnect attempt failed."); return null; });
        if (result?.qrCode) {
          decision = { ...decision, state: "needs_qr", attempts: MAX_RECONNECT_ATTEMPTS, nextAttemptAt: null, since: previous?.state === "needs_qr" ? previous.since : current.toISOString() };
        }
        log.info({ event: "channel_watchdog_reconnect_attempted", channelId: channel.id, attempt: decision.attempts, needsQr: Boolean(result?.qrCode) }, "Channel watchdog reconnect attempted.");
      }
    }

    const next = {
      workspaceId: channel.workspaceId, state: decision.state, since: decision.since,
      attempts: decision.attempts, nextAttemptAt: decision.nextAttemptAt,
      lastInboundAt: lastInboundAt ? lastInboundAt.toISOString() : previous?.lastInboundAt ?? null
    };
    memory.set(channel.id, next);
    const changed = !previous ? decision.state !== "ok" : previous.state !== decision.state;
    if (changed) {
      log.info({ event: "channel_watchdog_state_changed", channelId: channel.id, from: previous?.state ?? null, to: decision.state }, "Channel watchdog health state changed.");
      if (!dryRun) deps.publish({ type: "channel.health", workspaceId: channel.workspaceId, payload: toDto(channel.id, next) });
    }
    return evolutionState === null ? "unreachable" : "answered";
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const channels = await deps.prisma.channel.findMany({ where: { provider: "evolution" } });
      let checked = 0;
      let unreachable = 0;
      for (const channel of channels) {
        const outcome = await check(channel).catch((error: unknown): CheckOutcome => {
          log.error({ event: "channel_watchdog_check_failed", err: error, channelId: channel.id }, "Channel watchdog check failed.");
          return "answered";
        });
        if (outcome === "skipped") continue;
        checked += 1;
        if (outcome === "unreachable") unreachable += 1;
      }
      unreachableTicks = checked > 0 && unreachable === checked ? unreachableTicks + 1 : 0;
      lastTickOk = true;
      lastError = null;
    } catch (error) {
      lastTickOk = false;
      lastError = error instanceof Error ? error.message : String(error);
      log.error({ event: "channel_watchdog_tick_failed", err: error }, "Channel watchdog tick failed.");
    } finally {
      lastTickAt = now().toISOString();
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
    status() {
      return { lastTickAt, lastTickOk, lastError, unreachable: unreachableTicks >= UNREACHABLE_TICKS };
    },
    getHealth(workspaceId: string): ChannelHealthDto[] {
      return [...memory.entries()]
        .filter(([, entry]) => entry.workspaceId === workspaceId)
        .map(([channelId, entry]) => toDto(channelId, entry));
    }
  };
}
