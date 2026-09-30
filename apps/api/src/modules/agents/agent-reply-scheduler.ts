import { replayProspectingFollowupObservations } from "../prospecting/prospecting-followup-observation.js";
import type { ConversationFollowupsObserver } from "../followups/conversation-followups.service.js";
import { randomUUID } from "node:crypto";
import { AGENT_REPLY_LEASE_MS, recoverStaleAgentReplyClaim, type AgentReplyClaim } from "./agent-reply-claim.js";
import { autonomousAgentAllowed, findProspectingReservation } from "../prospecting/prospecting-policy.js";
import {
  DEFAULT_AGENT_REPLY_WAIT_SECONDS,
  readAgentBehaviorSettings
} from "../settings/agent-behavior-settings.js";

import { blocksAutonomousAgent } from '../assistant/assistant-policy.js';
type JsonValue = unknown;

type ActiveConversationRecord = {
  channel?: { encryptedConfig?: unknown } | null;
  id: string;
  workspaceId: string;
  aiControlStatus: string;
  activeAgentSessionId?: string | null;
  activeAgentSession?: {
    id: string;
    agentId: string;
    status: string;
    metadata?: JsonValue;
  } | null;
};

type PendingReplyRecord = {
  id: string;
  workspaceId: string;
  conversationId: string;
  agentId: string;
  sessionId?: string | null;
  prospectingGeneration?: string | null;
  lastMessageId: string;
  instruction?: string | null;
  attempts: number;
  status?: string;
  claimToken?: string | null;
  lockedAt?: Date | null;
  updatedAt?: Date;
  scheduledAt?: Date;
};

export interface AgentReplySchedulerPrismaLike {
  message?: { findMany(args: unknown): Promise<Array<{ metadata?: unknown; status: string }>> };
  workspaceMirror: {
    findUnique(args: unknown): Promise<{ limits?: JsonValue } | null>;
  };
  conversation: {
    findUnique(args: unknown): Promise<ActiveConversationRecord | null>;
  };
  aiAgentPendingReply: {
    upsert(args: unknown): Promise<unknown>;
    findUnique?(args: unknown): Promise<{ lastMessageId: string; status: string; scheduledAt?: Date; prospectingGeneration?: string | null } | null>;
    findMany(args: unknown): Promise<PendingReplyRecord[]>;
    update(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
}

export interface AgentReplySchedulerRuntime {
  runForMessage(input: {
    workspaceId: string;
    agentId: string;
    conversationId: string;
    messageId: string;
    trigger: "automation";
    instruction?: string | null;
    prospectingGeneration?: string | null;
    replyClaim?: AgentReplyClaim;
  }): Promise<{
    status: "completed" | "handoff_requested" | "skipped" | "failed";
    runId?: string;
    message?: string;
  }>;
}

export const DEFAULT_AGENT_REPLY_DEBOUNCE_MS = 40_000;

export function createAgentReplyScheduler(input: {
  prisma: AgentReplySchedulerPrismaLike;
  agentRuntime: AgentReplySchedulerRuntime;
  followupService?: ConversationFollowupsObserver;
  debounceMs?: number;
  pollIntervalMs?: number;
  batchSize?: number;
}) {
  const pollIntervalMs = input.pollIntervalMs ?? 5_000;
  const batchSize = input.batchSize ?? 20;
  let timer: NodeJS.Timeout | null = null;
  const wakeTimers = new Set<NodeJS.Timeout>();
  let isProcessing = false;

  async function scheduleActiveSessionForMessage(scheduleInput: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    now?: Date;
  }) {
    const conversation = await input.prisma.conversation.findUnique({
      where: {
        workspaceId_id: {
          workspaceId: scheduleInput.workspaceId,
          id: scheduleInput.conversationId
        }
      },
      include: {
        activeAgentSession: true,
        channel: true
      }
    });

    if (
      !conversation?.activeAgentSession ||
      !await autonomousAgentAllowed(input.prisma, { workspaceId: scheduleInput.workspaceId, conversationId: scheduleInput.conversationId, agentId: conversation.activeAgentSession?.agentId, sessionId: conversation.activeAgentSession?.id, channelConfig: conversation.channel?.encryptedConfig, aiControlStatus: conversation.aiControlStatus }) ||
      conversation.aiControlStatus === "human_controlled" ||
      conversation.activeAgentSession.status !== "active"
    ) {
      return { scheduled: false as const };
    }

    // A confirmation replay may race a newer live webhook. Debounce against the
    // latest persisted customer message instead of overwriting it with the first.
    const reservation = await findProspectingReservation(input.prisma, scheduleInput.workspaceId, scheduleInput.conversationId);
    const messageId = reservation?.latestInboundMessageId ?? scheduleInput.messageId;
    if (reservation && input.prisma.aiAgentPendingReply.findUnique) {
      const existing = await input.prisma.aiAgentPendingReply.findUnique({ where: { workspaceId_conversationId: {
        workspaceId: scheduleInput.workspaceId, conversationId: scheduleInput.conversationId } } });
      if (existing?.lastMessageId === messageId && existing.prospectingGeneration === reservation.generation) {
        if (existing.status === 'pending' && existing.scheduledAt) scheduleWake(existing.scheduledAt, new Date());
        return { scheduled: false as const };
      }
    }
    const now = scheduleInput.now ?? new Date();
    const debounceMs = await resolveDebounceMs(scheduleInput.workspaceId);
    const scheduledAt = new Date(now.getTime() + debounceMs);
    const session = conversation.activeAgentSession;
    const instruction = readInstruction(session.metadata);

    await input.prisma.aiAgentPendingReply.upsert({
      where: {
        workspaceId_conversationId: {
          workspaceId: scheduleInput.workspaceId,
          conversationId: scheduleInput.conversationId
        }
      },
      create: {
        workspaceId: scheduleInput.workspaceId,
        conversationId: scheduleInput.conversationId,
        agentId: session.agentId,
        ...(reservation ? { prospectingGeneration: reservation.generation } : {}),
        sessionId: session.id,
        lastMessageId: messageId,
        instruction,
        scheduledAt,
        status: "pending"
      },
      update: {
        agentId: session.agentId,
        ...(reservation ? { prospectingGeneration: reservation.generation } : {}),
        sessionId: session.id,
        lastMessageId: messageId,
        instruction,
        scheduledAt,
        status: "pending",
        lockedAt: null,
        claimToken: null,
        lastError: null
      }
    });
    scheduleWake(scheduledAt, now);

    return { scheduled: true as const, scheduledAt };
  }

  async function resolveDebounceMs(workspaceId: string) {
    if (input.debounceMs !== undefined) {
      return input.debounceMs;
    }

    try {
      const workspace = await input.prisma.workspaceMirror.findUnique({
        where: { workspaceId },
        select: { limits: true }
      });
      return readAgentBehaviorSettings(workspace?.limits).agentReplyWaitSeconds * 1_000;
    } catch {
      return DEFAULT_AGENT_REPLY_WAIT_SECONDS * 1_000;
    }
  }

  async function processDueReplies(processInput: { now?: Date } = {}) {
    if (isProcessing) {
      return [];
    }

    isProcessing = true;
    const now = processInput.now ?? new Date();

    try {
      // Stale processing claims are recoverable only before any network dispatch.
      // A persisted sending/uncertain delivery is never retried automatically.
      const stale = await input.prisma.aiAgentPendingReply.findMany({ where: { status: "processing",
        lockedAt: { lte: new Date(now.getTime() - AGENT_REPLY_LEASE_MS) } }, take: batchSize });
      for (const reply of stale) {
        if (reply.status !== "processing") continue;
        await recoverStaleAgentReplyClaim(input.prisma, reply, now);
      }
      await replayProspectingFollowupObservations(input.prisma, input.followupService, batchSize);
      const pendingReplies = await input.prisma.aiAgentPendingReply.findMany({
        where: { status: "pending", scheduledAt: { lte: now } }, orderBy: [{ scheduledAt: "asc" }], take: batchSize
      });
      const results: Array<{ id: string; status: string; runId?: string }> = [];
      for (const pendingReply of pendingReplies) {
        const token = randomUUID();
        const claimed = await input.prisma.aiAgentPendingReply.updateMany({ where: {
          workspaceId: pendingReply.workspaceId, id: pendingReply.id, status: "pending",
          lastMessageId: pendingReply.lastMessageId, agentId: pendingReply.agentId,
          prospectingGeneration: pendingReply.prospectingGeneration ?? null,
          ...(pendingReply.updatedAt ? { updatedAt: pendingReply.updatedAt } : {}),
          ...(pendingReply.scheduledAt ? { scheduledAt: pendingReply.scheduledAt } : {})
        }, data: { status: "processing", claimToken: token, lockedAt: now, attempts: { increment: 1 } } });
        if (!claimed.count) continue;
        const ownership = { workspaceId: pendingReply.workspaceId, id: pendingReply.id, status: "processing", claimToken: token };
        const heartbeat = setInterval(() => {
          void input.prisma.aiAgentPendingReply.updateMany({ where: ownership, data: { lockedAt: new Date() } }).catch(() => undefined);
        }, AGENT_REPLY_LEASE_MS / 3);
        heartbeat.unref?.();
        try {
          const run = await input.agentRuntime.runForMessage({ workspaceId: pendingReply.workspaceId,
            agentId: pendingReply.agentId, conversationId: pendingReply.conversationId,
            messageId: pendingReply.lastMessageId, trigger: "automation", replyClaim: { id: pendingReply.id, token },
            ...(pendingReply.prospectingGeneration ? { prospectingGeneration: pendingReply.prospectingGeneration } : {}),
            instruction: pendingReply.instruction ?? null });
          const status = run.status === "failed" || run.status === "skipped" ? run.status : "completed";
          await input.prisma.aiAgentPendingReply.updateMany({ where: ownership,
            data: { status, claimToken: null, lockedAt: null,
              lastError: status === "failed" || status === "skipped" ? run.message ?? `Agent reply ${run.status}.` : null } });
          results.push({ id: pendingReply.id, status: run.status, runId: run.runId });
        } catch (error) {
          await input.prisma.aiAgentPendingReply.updateMany({ where: ownership, data: { status: "failed", claimToken: null,
            lockedAt: null, lastError: error instanceof Error ? error.message : "Agent reply processing failed." } });
          results.push({ id: pendingReply.id, status: "failed" });
        } finally { clearInterval(heartbeat); }
      }

      return results;
    } finally {
      isProcessing = false;
    }
  }

  function start() {
    if (timer) {
      return;
    }

    timer = setInterval(() => {
      void processDueReplies();
    }, pollIntervalMs);
    timer.unref?.();
  }

  function stop() {
    if (!timer) {
      for (const wakeTimer of wakeTimers) {
        clearTimeout(wakeTimer);
      }
      wakeTimers.clear();
      return;
    }

    clearInterval(timer);
    timer = null;
    for (const wakeTimer of wakeTimers) {
      clearTimeout(wakeTimer);
    }
    wakeTimers.clear();
  }

  function scheduleWake(scheduledAt: Date, now: Date) {
    const delayMs = Math.max(0, scheduledAt.getTime() - now.getTime() + 100);
    const wakeTimer = setTimeout(() => {
      wakeTimers.delete(wakeTimer);
      void processDueReplies();
    }, delayMs);
    wakeTimers.add(wakeTimer);
    wakeTimer.unref?.();
  }

  return {
    scheduleActiveSessionForMessage,
    processDueReplies,
    start,
    stop
  };
}

function readInstruction(metadata: JsonValue) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const instruction = (metadata as Record<string, unknown>).instruction;
  return typeof instruction === "string" && instruction.trim().length > 0
    ? instruction.trim()
    : null;
}
