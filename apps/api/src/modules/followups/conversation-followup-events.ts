import {
  conversationFollowupPurposeSchema,
  conversationFollowupReasonCodeSchema,
  conversationFollowupSchema,
  type ConversationFollowupDto,
  type MessageType,
  type RealtimeEvent
} from "@prymeira-talk/shared";

type DateLike = Date | string;

export type ConversationFollowupPublicRecord = {
  id: string;
  workspaceId: string;
  conversationId: string;
  agentId: string;
  kind: "qualification" | "human_commercial";
  status: string;
  activeKey?: string | null;
  stepIndex: number;
  scheduledAt: DateLike;
  lockedAt?: DateLike | null;
  draftBody?: string | null;
  finalBody?: string | null;
  reason?: string | null;
  sentByUserId?: string | null;
  sentAt?: DateLike | null;
  cancelledByUserId?: string | null;
  cancelledAt?: DateLike | null;
  createdAt?: DateLike;
  updatedAt?: DateLike;
  conversation?: {
    contact?: { name?: string | null; phone?: string | null; [privateField: string]: unknown } | null;
    channel?: { displayName?: string | null; [privateField: string]: unknown } | null;
    [privateField: string]: unknown;
  } | null;
  anchorMessage?: {
    id?: string | null;
    body?: string | null;
    type?: MessageType | null;
    createdAt?: DateLike | null;
    [privateField: string]: unknown;
  } | null;
  decision?: unknown;
  [privateField: string]: unknown;
};

export type ConversationFollowupPublisher = {
  publishUpdated(record: ConversationFollowupPublicRecord): void | Promise<void>;
};

type RealtimePublisher = {
  publish(event: RealtimeEvent): void;
};

export function createConversationFollowupRealtimePublisher(
  realtime: RealtimePublisher
): ConversationFollowupPublisher {
  return {
    publishUpdated(record) {
      const payload = toConversationFollowupDto(record);
      realtime.publish({
        type: "conversation_followup.updated",
        workspaceId: payload.workspaceId,
        payload
      });
    }
  };
}

export async function publishPersistedConversationFollowup(input: {
  store: {
    findFirst(args: unknown): Promise<ConversationFollowupPublicRecord | null>;
  };
  publisher?: ConversationFollowupPublisher;
  workspaceId: string;
  followupId: string;
}) {
  if (!input.publisher) return null;
  const record = await input.store.findFirst({
    where: { workspaceId: input.workspaceId, id: input.followupId },
    select: conversationFollowupPublicSelect
  });
  if (record) await input.publisher.publishUpdated(record);
  return record;
}

export const conversationFollowupPublicSelect = {
  id: true,
  workspaceId: true,
  conversationId: true,
  agentId: true,
  kind: true,
  status: true,
  activeKey: true,
  stepIndex: true,
  scheduledAt: true,
  lockedAt: true,
  draftBody: true,
  finalBody: true,
  reason: true,
  sentByUserId: true,
  sentAt: true,
  cancelledByUserId: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true,
  decision: true,
  conversation: {
    select: {
      contact: { select: { name: true, phone: true } },
      channel: { select: { displayName: true } }
    }
  },
  anchorMessage: {
    select: { id: true, body: true, type: true, createdAt: true }
  }
} as const;

export function toConversationFollowupDto(
  record: ConversationFollowupPublicRecord
): ConversationFollowupDto {
  const createdAt = record.createdAt ?? record.scheduledAt;
  const updatedAt = record.updatedAt ?? createdAt;
  const base = {
    id: record.id,
    workspaceId: record.workspaceId,
    conversationId: record.conversationId,
    agentId: record.agentId,
    kind: record.kind,
    stepIndex: record.stepIndex,
    scheduledAt: toIso(record.scheduledAt),
    draftBody: record.draftBody ?? null,
    contact: {
      name: record.conversation?.contact?.name ?? null,
      phone: record.conversation?.contact?.phone ?? null
    },
    channel: {
      displayName: record.conversation?.channel?.displayName ?? null
    },
    anchorMessage: {
      id: record.anchorMessage?.id ?? null,
      body: record.anchorMessage?.body ?? null,
      type: record.anchorMessage?.type ?? null,
      createdAt: record.anchorMessage?.createdAt ? toIso(record.anchorMessage.createdAt) : null
    },
    purpose: safePurpose(record.decision),
    reasonCode: isActiveStatus(record.status) ? safeActiveReason(record.reason) : null,
    createdAt: toIso(createdAt),
    updatedAt: toIso(updatedAt)
  };

  switch (record.status) {
    case "sent":
      return conversationFollowupSchema.parse({
        ...base,
        status: "sent",
        finalBody: record.finalBody ?? "",
        sentAt: toIso(record.sentAt ?? updatedAt),
        sentByUserId: record.sentByUserId ?? null
      });
    case "cancelled":
      return conversationFollowupSchema.parse({
        ...base,
        status: "cancelled",
        reason: safeReason(record.reason, "cancelled"),
        cancelledAt: toIso(record.cancelledAt ?? updatedAt),
        cancelledByUserId: record.cancelledByUserId ?? null
      });
    case "failed":
      return conversationFollowupSchema.parse({ ...base, status: "failed", reason: safeReason(record.reason, "failed") });
    case "skipped":
      return conversationFollowupSchema.parse({ ...base, status: "skipped", reason: safeReason(record.reason, "skipped") });
    case "expired":
      return conversationFollowupSchema.parse({ ...base, status: "expired", reason: safeReason(record.reason, "expired") });
    case "processing":
      return conversationFollowupSchema.parse({ ...base, status: "processing" });
    case "review":
      return conversationFollowupSchema.parse({ ...base, status: "review" });
    default:
      return conversationFollowupSchema.parse({ ...base, status: "scheduled" });
  }
}

function safePurpose(decision: unknown) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return null;
  const parsed = conversationFollowupPurposeSchema.safeParse(
    (decision as Record<string, unknown>).purpose
  );
  return parsed.success ? parsed.data : null;
}

function safeActiveReason(reason: string | null | undefined) {
  const parsed = conversationFollowupReasonCodeSchema.safeParse(reason);
  if (parsed.success) return parsed.data;

  switch (reason) {
    case "followup_agent_unavailable":
      return "agent_unavailable";
    case "followup_conversation_unavailable":
      return "context_unavailable";
    case "provider_handoff_required":
      return "handoff_required";
    case "provider_reply_missing":
      return "provider_reply_missing";
    default:
      return reason?.startsWith("audit_") ? "audit_blocked" : null;
  }
}

function isActiveStatus(status: string) {
  return status === "scheduled" || status === "processing" || status === "review";
}

function safeReason(
  reason: string | null | undefined,
  status: "cancelled" | "failed" | "skipped" | "expired"
) {
  const allowed = new Set([
    "manual_cancelled",
    "not_interested",
    "wrong_contact",
    "duplicate",
    "other",
    "no_followup",
    "customer_replied",
    "outbound_replaced",
    "conversation_missing",
    "conversation_closed",
    "human_controlled",
    "session_context_changed",
    "delivery_completion_failed"
  ]);
  if (reason && allowed.has(reason)) return reason;
  return status === "failed" ? "delivery_failed" : "system_cancelled";
}

function toIso(value: DateLike) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RangeError("Follow-up timestamp must be valid.");
  return date.toISOString();
}
