import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { RealtimeEvent } from "@prymeira-talk/shared";
import { z } from "zod";
import { canPerform, type Permission } from "../access/roles.js";
import { resolveCurrentUserProfileId } from "../conversations/current-user.js";
import {
  OutboundDeliveryUncertainError,
  type ConversationOutboundTextDelivery
} from "../conversations/conversations.service.js";
import {
  createConversationFollowupsService,
  type ConversationFollowupsPrismaLike,
  type RevalidateActiveFollowupResult
} from "./conversation-followups.service.js";
import { addBusinessMinutes } from "./business-time.js";
import {
  conversationFollowupPublicSelect,
  createConversationFollowupRealtimePublisher,
  publishPersistedConversationFollowup,
  toConversationFollowupDto,
  type ConversationFollowupPublicRecord,
  type ConversationFollowupPublisher
} from "./conversation-followup-events.js";

const FOLLOWUP_LIST_STATUSES = ["review", "scheduled", "sent", "cancelled"] as const;
const ACTIVE_MANUAL_STATUSES = ["scheduled", "review"] as const;
const POSTPONE_BUSINESS_MINUTES = 60;

const listQuerySchema = z
  .object({
    status: z.enum(FOLLOWUP_LIST_STATUSES)
  })
  .strict();
const followupParamsSchema = z.object({ id: z.string().uuid() }).strict();
const expectedUpdatedAtSchema = z.string().datetime({ offset: true });
const sendBodySchema = z
  .object({
    body: z.string().trim().min(1).max(4000),
    expectedUpdatedAt: expectedUpdatedAtSchema
  })
  .strict();
const postponeBodySchema = z.object({ expectedUpdatedAt: expectedUpdatedAtSchema }).strict();
const cancelBodySchema = z
  .object({
    reason: z.enum(["manual_cancelled", "not_interested", "wrong_contact", "duplicate", "other"]),
    expectedUpdatedAt: expectedUpdatedAtSchema
  })
  .strict();
const noFollowupBodySchema = z.object({ expectedUpdatedAt: expectedUpdatedAtSchema }).strict();

type DateLike = Date | string;
type FollowupRecord = ConversationFollowupPublicRecord & {
  activeKey: string | null;
  lockedAt: DateLike | null;
  createdAt: DateLike;
  updatedAt: DateLike;
};

type FollowupStore = {
  findFirst(args: unknown): Promise<FollowupRecord | null>;
  findMany(args: unknown): Promise<FollowupRecord[]>;
  updateMany(args: unknown): Promise<{ count: number }>;
  create(args: unknown): Promise<FollowupRecord>;
};

type ReservedMessageRecord = {
  id: string;
  workspaceId: string;
  conversationId: string;
  direction: string;
  status: string;
  metadata?: unknown;
};

type ManualSendTransaction = {
  conversationFollowup: FollowupStore;
  message: {
    findUnique(args: unknown): Promise<ReservedMessageRecord | null>;
    create(args: unknown): Promise<ReservedMessageRecord>;
    update(args: unknown): Promise<ReservedMessageRecord>;
    deleteMany(args: unknown): Promise<{ count: number }>;
  };
};

export type ConversationFollowupsRoutesPrismaLike = Omit<
  ConversationFollowupsPrismaLike,
  "conversationFollowup" | "$transaction"
> & {
  conversationFollowup: FollowupStore;
  message: ConversationFollowupsPrismaLike["message"] & ManualSendTransaction["message"];
  userProfile: {
    findFirst(args: unknown): Promise<{ id: string } | null>;
  };
  $transaction<T>(callback: (tx: ManualSendTransaction) => Promise<T>): Promise<T>;
};

type FollowupLifecycle = {
  revalidateActiveFollowup(input: {
    workspaceId: string;
    followupId: string;
    now?: Date;
    claim?: { lockedAt: Date };
  }): Promise<RevalidateActiveFollowupResult>;
};

type RealtimePublisher = {
  publish(event: RealtimeEvent): void;
};

export interface ConversationFollowupsRoutesOptions {
  /** Test-only injection. The application always uses app.prisma. */
  prisma?: ConversationFollowupsRoutesPrismaLike;
  followups?: FollowupLifecycle;
  outbound?: ConversationOutboundTextDelivery;
  realtime?: RealtimePublisher;
  publisher?: ConversationFollowupPublisher;
  now?: () => Date;
  resolveActorUserId?: (input: {
    workspaceId: string;
    clerkUserId?: string | null;
    authorizationHeader: string | undefined;
  }) => Promise<string | null>;
}

const followupSelect = conversationFollowupPublicSelect;

/**
 * Review queue API. Its DTO intentionally omits JEV decisions, prompts,
 * retrieved knowledge and provider error payloads.
 */
export const conversationFollowupsRoutes: FastifyPluginAsync<ConversationFollowupsRoutesOptions> = async (
  app,
  options
) => {
  const prisma = (options.prisma ?? (app.prisma as unknown as ConversationFollowupsRoutesPrismaLike));
  const realtime = options.realtime ?? app.realtime;
  const publisher = options.publisher ?? createConversationFollowupRealtimePublisher(realtime);
  const followups = options.followups ?? createConversationFollowupsService(
    prisma as unknown as ConversationFollowupsPrismaLike,
    { publisher }
  );
  const now = options.now ?? (() => new Date());
  const resolveActorUserId = options.resolveActorUserId ?? ((input) =>
    resolveCurrentUserProfileId({
      prisma,
      workspaceId: input.workspaceId,
      clerkUserId: input.clerkUserId,
      authorizationHeader: input.authorizationHeader
    })
  );

  async function load(workspaceId: string, id: string) {
    return prisma.conversationFollowup.findFirst({
      where: { workspaceId, id },
      select: followupSelect
    });
  }

  const publish = (workspaceId: string, followupId: string) =>
    publishPersistedConversationFollowup({
      store: prisma.conversationFollowup,
      publisher,
      workspaceId,
      followupId
    });

  async function stale(reply: FastifyReply, record: FollowupRecord) {
    return reply.code(409).send({
      code: "FOLLOWUP_STALE",
      followup: toConversationFollowupDto(record)
    });
  }

  async function revalidateForMutation(input: {
    workspaceId: string;
    followupId: string;
    expectedUpdatedAt: Date;
    reply: FastifyReply;
  }) {
    const initial = await load(input.workspaceId, input.followupId);
    if (!initial) {
      input.reply.code(404).send({ code: "FOLLOWUP_NOT_FOUND", error: "Follow-up not found." });
      return null;
    }
    if (!sameTimestamp(initial.updatedAt, input.expectedUpdatedAt)) {
      await stale(input.reply, initial);
      return null;
    }

    const result = await followups.revalidateActiveFollowup({
      workspaceId: input.workspaceId,
      followupId: input.followupId,
      now: now()
    });
    if (result.status === "valid") {
      return initial;
    }

    const current = await load(input.workspaceId, input.followupId);
    if (!current) {
      input.reply.code(404).send({ code: "FOLLOWUP_NOT_FOUND", error: "Follow-up not found." });
      return null;
    }
    await stale(input.reply, current);
    return null;
  }

  async function resolveActor(request: { talk: { workspaceId: string; clerkUserId?: string | null }; headers: { authorization?: string } }) {
    return resolveActorUserId({
      workspaceId: request.talk.workspaceId,
      clerkUserId: request.talk.clerkUserId,
      authorizationHeader: request.headers.authorization
    });
  }

  app.get("/followups", async (request, reply) => {
    if (!requirePermission(request.talk.role, "conversation.read", reply)) return reply;
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ code: "FOLLOWUP_INVALID_QUERY", error: "A valid status is required." });
    }

    const records = await prisma.conversationFollowup.findMany({
      where: {
        workspaceId: request.talk.workspaceId,
        status: query.data.status === "cancelled"
          ? { in: ["cancelled", "failed", "skipped", "expired"] }
          : query.data.status
      },
      select: followupSelect,
      orderBy: query.data.status === "review" || query.data.status === "scheduled"
        ? [{ scheduledAt: "asc" }, { createdAt: "asc" }]
        : [{ updatedAt: "desc" }],
      take: 100
    });
    return records.map(toConversationFollowupDto);
  });

  app.post("/followups/:id/send", async (request, reply) => {
    if (!requirePermission(request.talk.role, "conversation.reply", reply)) return reply;
    const params = followupParamsSchema.safeParse(request.params);
    const body = sendBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ code: "FOLLOWUP_INVALID_REQUEST", error: "Invalid follow-up send request." });
    }
    if (!options.outbound) {
      return reply.code(503).send({ code: "FOLLOWUP_DELIVERY_UNAVAILABLE", error: "Follow-up delivery is unavailable." });
    }

    const expectedUpdatedAt = new Date(body.data.expectedUpdatedAt);
    const actorUserId = await resolveActor(request);
    const current = await revalidateForMutation({
      workspaceId: request.talk.workspaceId,
      followupId: params.data.id,
      expectedUpdatedAt,
      reply
    });
    if (!current) return reply;
    if (current.status !== "review" || current.activeKey !== "active") {
      return stale(reply, current);
    }

    const claimAt = now();
    let reserved = false;
    try {
      reserved = await reserveManualDelivery({
        prisma,
        followup: current,
        expectedUpdatedAt,
        claimAt,
        body: body.data.body,
        sentByUserId: actorUserId
      });
    } catch {
      return reply.code(503).send({
        code: "FOLLOWUP_RESERVATION_FAILED",
        error: "The follow-up delivery could not be reserved safely."
      });
    }
    if (!reserved) {
      const latest = await load(request.talk.workspaceId, current.id);
      return latest
        ? stale(reply, latest)
        : reply.code(404).send({ code: "FOLLOWUP_NOT_FOUND", error: "Follow-up not found." });
    }
    await publish(request.talk.workspaceId, current.id);

    // A customer can reply while this review is being opened. Validate once
    // more after the atomic claim and immediately before provider delivery.
    const beforeDelivery = await followups.revalidateActiveFollowup({
      workspaceId: request.talk.workspaceId,
      followupId: current.id,
      now: now()
    });
    if (beforeDelivery.status !== "valid") {
      await removePendingReservation(prisma, request.talk.workspaceId, current.id);
      const latest = await load(request.talk.workspaceId, current.id);
      if (!latest) {
        return reply.code(404).send({ code: "FOLLOWUP_NOT_FOUND", error: "Follow-up not found." });
      }
      return stale(reply, latest);
    }

    let delivery: Awaited<ReturnType<ConversationOutboundTextDelivery["createPendingOutboundMessage"]>>;
    try {
      delivery = await options.outbound.createPendingOutboundMessage({
        workspaceId: request.talk.workspaceId,
        conversationId: current.conversationId,
        body: body.data.body,
        sentByUserId: actorUserId,
        reservedMessageId: current.id,
        metadata: { source: "followup_review", followupId: current.id }
      });
    } catch (error) {
      if (error instanceof OutboundDeliveryUncertainError) {
        const guarded = await guardUncertainDelivery(
          prisma,
          request.talk.workspaceId,
          current.id,
          claimAt,
          body.data.body
        ).catch(() => false);
        if (guarded) await publish(request.talk.workspaceId, current.id);
        return reply.code(502).send({
          code: "FOLLOWUP_DELIVERY_UNCERTAIN",
          error: "The provider may have accepted the follow-up. It will not be retried automatically."
        });
      }
      const afterRejection = await followups.revalidateActiveFollowup({
        workspaceId: request.talk.workspaceId,
        followupId: current.id,
        now: now(),
        claim: { lockedAt: claimAt }
      });
      if (afterRejection.status !== "valid") {
        await removePendingReservation(prisma, request.talk.workspaceId, current.id);
        const latest = await load(request.talk.workspaceId, current.id);
        return latest
          ? stale(reply, latest)
          : reply.code(404).send({ code: "FOLLOWUP_NOT_FOUND", error: "Follow-up not found." });
      }
      const restored = await restoreReviewAndRemoveReservation(prisma, request.talk.workspaceId, current.id, claimAt);
      if (restored) await publish(request.talk.workspaceId, current.id);
      return reply.code(502).send({
        code: "FOLLOWUP_DELIVERY_FAILED",
        error: "The follow-up was not sent."
      });
    }

    if (delivery.message.status !== "sent") {
      const restored = await restoreReviewAndRemoveReservation(prisma, request.talk.workspaceId, current.id, claimAt);
      if (restored) await publish(request.talk.workspaceId, current.id);
      return reply.code(502).send({
        code: "FOLLOWUP_DELIVERY_UNCONFIRMED",
        error: "The follow-up delivery was not confirmed."
      });
    }

    const sentAt = now();
    let markedSent: { count: number };
    try {
      markedSent = await prisma.conversationFollowup.updateMany({
        where: {
          workspaceId: request.talk.workspaceId,
          id: current.id,
          status: "processing",
          activeKey: "active",
          lockedAt: claimAt
        },
        data: {
          status: "sent",
          activeKey: null,
          lockedAt: null,
          finalBody: body.data.body,
          sentAt,
          sentByUserId: actorUserId,
          reason: null
        }
      });
    } catch {
      markedSent = { count: 0 };
    }

    if (markedSent.count !== 1) {
      // The provider already confirmed delivery. Never move this record back
      // to review/scheduled: that could cause a duplicate WhatsApp message.
      let guarded = { count: 0 };
      try {
        guarded = await prisma.conversationFollowup.updateMany({
          where: {
            workspaceId: request.talk.workspaceId,
            id: current.id,
            status: "processing",
            activeKey: "active",
            lockedAt: claimAt
          },
          data: {
            status: "failed",
            activeKey: null,
            lockedAt: null,
            finalBody: body.data.body,
            reason: "delivery_completion_failed"
          }
        });
      } catch {
        // A database outage leaves the claimed `processing` lock in place,
        // which is deliberately not eligible for another manual/scheduled send.
      }
      const latest = await load(request.talk.workspaceId, current.id).catch(() => null);
      if (guarded.count === 1 && latest) await publisher.publishUpdated(latest);
      if (latest) return stale(reply, latest);
      return reply.code(409).send({ code: "FOLLOWUP_STALE", error: "Follow-up state changed." });
    }

    const result = await load(request.talk.workspaceId, current.id);
    if (!result) {
      return reply.code(500).send({ code: "FOLLOWUP_WRITE_FAILED", error: "Follow-up state was not persisted." });
    }
    await publisher.publishUpdated(result);
    return toConversationFollowupDto(result);
  });

  app.post("/followups/:id/postpone", async (request, reply) => {
    if (!requirePermission(request.talk.role, "conversation.reply", reply)) return reply;
    const params = followupParamsSchema.safeParse(request.params);
    const body = postponeBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ code: "FOLLOWUP_INVALID_REQUEST", error: "Invalid follow-up postpone request." });
    }
    const expectedUpdatedAt = new Date(body.data.expectedUpdatedAt);
    const current = await revalidateForMutation({ workspaceId: request.talk.workspaceId, followupId: params.data.id, expectedUpdatedAt, reply });
    if (!current) return reply;
    if (!isManuallyActionable(current)) return stale(reply, current);

    const scheduledAt = nextBusinessWindow(now());
    const updated = await prisma.conversationFollowup.updateMany({
      where: manualActiveWhere(request.talk.workspaceId, current.id, expectedUpdatedAt),
      data: { status: "scheduled", scheduledAt, lockedAt: null, reason: "manual_postponed" }
    });
    return respondConditionalMutation({ prisma, workspaceId: request.talk.workspaceId, id: current.id, count: updated.count, reply, publisher });
  });

  app.post("/followups/:id/cancel", async (request, reply) => {
    if (!requirePermission(request.talk.role, "conversation.reply", reply)) return reply;
    const params = followupParamsSchema.safeParse(request.params);
    const body = cancelBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ code: "FOLLOWUP_INVALID_REQUEST", error: "Invalid follow-up cancel request." });
    }
    const expectedUpdatedAt = new Date(body.data.expectedUpdatedAt);
    const cancelledByUserId = await resolveActor(request);
    const current = await revalidateForMutation({ workspaceId: request.talk.workspaceId, followupId: params.data.id, expectedUpdatedAt, reply });
    if (!current) return reply;
    if (!isManuallyActionable(current)) return stale(reply, current);

    const updated = await prisma.conversationFollowup.updateMany({
      where: manualActiveWhere(request.talk.workspaceId, current.id, expectedUpdatedAt),
      data: {
        status: "cancelled",
        activeKey: null,
        lockedAt: null,
        cancelledAt: now(),
        cancelledByUserId,
        reason: body.data.reason
      }
    });
    return respondConditionalMutation({ prisma, workspaceId: request.talk.workspaceId, id: current.id, count: updated.count, reply, publisher });
  });

  app.post("/followups/:id/no-followup", async (request, reply) => {
    if (!requirePermission(request.talk.role, "conversation.reply", reply)) return reply;
    const params = followupParamsSchema.safeParse(request.params);
    const body = noFollowupBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ code: "FOLLOWUP_INVALID_REQUEST", error: "Invalid no-follow-up request." });
    }
    const expectedUpdatedAt = new Date(body.data.expectedUpdatedAt);
    const cancelledByUserId = await resolveActor(request);
    const current = await revalidateForMutation({ workspaceId: request.talk.workspaceId, followupId: params.data.id, expectedUpdatedAt, reply });
    if (!current) return reply;
    if (!isManuallyActionable(current)) return stale(reply, current);

    const updated = await prisma.conversationFollowup.updateMany({
      where: manualActiveWhere(request.talk.workspaceId, current.id, expectedUpdatedAt),
      data: {
        status: "cancelled",
        activeKey: null,
        lockedAt: null,
        cancelledAt: now(),
        cancelledByUserId,
        reason: "no_followup"
      }
    });
    return respondConditionalMutation({ prisma, workspaceId: request.talk.workspaceId, id: current.id, count: updated.count, reply, publisher });
  });
};

function requirePermission(
  role: "owner" | "manager" | "agent",
  permission: Permission,
  reply: FastifyReply
) {
  if (
    (role === "owner" || role === "manager" || role === "agent") &&
    canPerform(role, permission)
  ) return true;
  reply.code(403).send({ code: "FOLLOWUP_FORBIDDEN", error: "You do not have permission for this follow-up action." });
  return false;
}

function isManuallyActionable(record: FollowupRecord) {
  return record.activeKey === "active" && ACTIVE_MANUAL_STATUSES.includes(record.status as (typeof ACTIVE_MANUAL_STATUSES)[number]);
}

function manualActiveWhere(workspaceId: string, id: string, expectedUpdatedAt: Date) {
  return {
    workspaceId,
    id,
    activeKey: "active",
    status: { in: ACTIVE_MANUAL_STATUSES },
    updatedAt: expectedUpdatedAt
  };
}

async function reserveManualDelivery(input: {
  prisma: ConversationFollowupsRoutesPrismaLike;
  followup: FollowupRecord;
  expectedUpdatedAt: Date;
  claimAt: Date;
  body: string;
  sentByUserId: string | null;
}) {
  return input.prisma.$transaction(async (tx) => {
    const claimed = await tx.conversationFollowup.updateMany({
      where: {
        workspaceId: input.followup.workspaceId,
        id: input.followup.id,
        status: "review",
        activeKey: "active",
        updatedAt: input.expectedUpdatedAt
      },
      data: {
        status: "processing",
        lockedAt: input.claimAt,
        attempts: { increment: 1 }
      }
    });
    if (claimed.count !== 1) return false;

    const existing = await tx.message.findUnique({
      where: {
        workspaceId_id: {
          workspaceId: input.followup.workspaceId,
          id: input.followup.id
        }
      }
    });
    const metadata = { source: "followup_review", followupId: input.followup.id };
    const data = {
      workspaceId: input.followup.workspaceId,
      conversationId: input.followup.conversationId,
      direction: "outbound",
      type: "text",
      body: input.body,
      status: "pending",
      sentByUserId: input.sentByUserId,
      metadata
    };

    if (existing) {
      const existingMetadata = asRecord(existing.metadata);
      if (
        existing.workspaceId !== input.followup.workspaceId ||
        existing.conversationId !== input.followup.conversationId ||
        existing.direction !== "outbound" ||
        existing.status !== "pending" ||
        existingMetadata?.source !== "followup_review" ||
        existingMetadata.followupId !== input.followup.id
      ) {
        throw new Error("Reserved message id is already in use.");
      }
      await tx.message.update({
        where: { workspaceId_id: { workspaceId: input.followup.workspaceId, id: input.followup.id } },
        data
      });
    } else {
      await tx.message.create({ data: { id: input.followup.id, ...data } });
    }
    return true;
  });
}

async function guardUncertainDelivery(
  prisma: ConversationFollowupsRoutesPrismaLike,
  workspaceId: string,
  id: string,
  lockedAt: Date,
  finalBody: string
) {
  const result = await prisma.conversationFollowup.updateMany({
    where: { workspaceId, id, status: "processing", activeKey: "active", lockedAt },
    data: {
      status: "failed",
      activeKey: null,
      lockedAt: null,
      finalBody,
      reason: "manual_delivery_uncertain"
    }
  });
  return result.count === 1;
}

async function restoreReviewAndRemoveReservation(
  prisma: ConversationFollowupsRoutesPrismaLike,
  workspaceId: string,
  id: string,
  lockedAt: Date
) {
  return prisma.$transaction(async (tx) => {
    const result = await tx.conversationFollowup.updateMany({
      where: { workspaceId, id, status: "processing", activeKey: "active", lockedAt },
      data: { status: "review", lockedAt: null, reason: "manual_send_failed" }
    });
    if (result.count !== 1) return false;
    await removePendingReservationFromStore(tx.message, workspaceId, id);
    return true;
  });
}

async function removePendingReservation(
  prisma: ConversationFollowupsRoutesPrismaLike,
  workspaceId: string,
  id: string
) {
  return prisma.$transaction((tx) => removePendingReservationFromStore(tx.message, workspaceId, id));
}

async function removePendingReservationFromStore(
  message: ManualSendTransaction["message"],
  workspaceId: string,
  id: string
) {
  const reservation = await message.findUnique({ where: { workspaceId_id: { workspaceId, id } } });
  const metadata = asRecord(reservation?.metadata);
  if (
    reservation?.status !== "pending" ||
    reservation.direction !== "outbound" ||
    metadata?.source !== "followup_review" ||
    metadata.followupId !== id
  ) return false;
  const deleted = await message.deleteMany({ where: { workspaceId, id, status: "pending" } });
  return deleted.count === 1;
}

async function respondConditionalMutation(input: {
  prisma: ConversationFollowupsRoutesPrismaLike;
  workspaceId: string;
  id: string;
  count: number;
  reply: FastifyReply;
  publisher: ConversationFollowupPublisher;
}) {
  const current = await input.prisma.conversationFollowup.findFirst({
    where: { workspaceId: input.workspaceId, id: input.id },
    select: followupSelect
  });
  if (!current) {
    return input.reply.code(404).send({ code: "FOLLOWUP_NOT_FOUND", error: "Follow-up not found." });
  }
  if (input.count !== 1) {
    return input.reply.code(409).send({ code: "FOLLOWUP_STALE", followup: toConversationFollowupDto(current) });
  }
  await input.publisher.publishUpdated(current);
  return toConversationFollowupDto(current);
}

function nextBusinessWindow(from: Date) {
  return addBusinessMinutes({
    from,
    minutes: POSTPONE_BUSINESS_MINUTES,
    timeZone: "America/Sao_Paulo",
    businessDays: [1, 2, 3, 4, 5],
    businessHours: { start: "08:00", end: "18:00" }
  });
}

function sameTimestamp(left: DateLike, right: Date) {
  const value = left instanceof Date ? left : new Date(left);
  return Number.isFinite(value.getTime()) && value.getTime() === right.getTime();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
