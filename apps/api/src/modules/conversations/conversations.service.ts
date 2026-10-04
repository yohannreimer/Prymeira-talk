import { lastMessageKind, messageLocationSchema } from '@prymeira-talk/shared';
import { lockProspectingConversation } from "../prospecting/prospecting-lock.js";
import { reserveProspectingOutbound, adoptProspectingOutbound, dispatchProspectingOutbound, confirmProspectingOutbound, cancelProspectingOutbound } from "../prospecting/prospecting-delivery.js";
import { stopProspectingConversation, autonomousAgentAllowed, releaseEndedProspectingBinding, findProspectingReservation } from "../prospecting/prospecting-policy.js";
import type { ConversationStatus, Prisma, PrismaClient } from "@prisma/client";
import { createHash } from 'node:crypto';
import { prepareVoiceRecording } from './outbound-audio.js';
import type {
  ContactBoardMembershipDto,
  ContactBoardMoveSource,
  ConversationDto,
  ConversationLastMessage,
  InboxView,
  MessageDto
} from "@prymeira-talk/shared";
import type { EvolutionRuntime } from "../evolution/evolution-runtime.js";
import { EvolutionClientError } from "../evolution/evolution.client.js";
import { MetaClientError, type MetaClient } from "../meta/meta.client.js";
import { canonicalizePhone } from "../contacts/phone-normalization.js";
import { visibleConversationMessageWhere, withoutInternalFollowupReservations } from "./internal-message.js";
import { measureInboxAssembly } from "../../plugins/inbox-timing.js";

type DateLike = Date | string;

export class ConversationNotFoundError extends Error {
  code = "CONVERSATION_NOT_FOUND" as const;
  statusCode = 404 as const;

  constructor() {
    super("Conversation not found.");
    this.name = "ConversationNotFoundError";
  }
}

type ConversationActionErrorCode =
  | "CURRENT_USER_REQUIRED"
  | "CURRENT_USER_NOT_FOUND"
  | "DEPARTMENT_NOT_FOUND"
  | "BOARD_STAGE_NOT_FOUND"
  | "HANDOFF_ACTION_NOT_AVAILABLE";

export class ConversationActionError extends Error {
  statusCode = 409 as const;

  constructor(
    public code: ConversationActionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ConversationActionError";
  }
}

type OutboundMessageValidationErrorCode =
  | "AUDIO_CHANNEL_NOT_SUPPORTED"
  | "INVALID_VOICE_RECORDING"
  | "OUTBOUND_CONTACT_PHONE_REQUIRED"
  | "OUTBOUND_PROVIDER_KEY_REQUIRED"
  | "META_MEDIA_NOT_SUPPORTED"
  | "CONTACT_CARD_NOT_SUPPORTED"
  | "META_NOT_CONFIGURED"
  | "META_SERVICE_WINDOW_CLOSED";

export class OutboundMessageValidationError extends Error {
  statusCode = 400 as const;

  constructor(
    public code: OutboundMessageValidationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "OutboundMessageValidationError";
  }
}

export class OutboundDeliveryUncertainError extends Error {
  code = "OUTBOUND_DELIVERY_UNCERTAIN" as const;
  statusCode = 502 as const;

  constructor() {
    super("The outbound provider may have accepted the message, so this delivery cannot be retried safely.");
    this.name = "OutboundDeliveryUncertainError";
  }
}

function isDefinitiveProviderRejection(error: unknown) {
  if (!(error instanceof EvolutionClientError || error instanceof MetaClientError)) return false;
  // 408/409/425/429 can represent a request whose delivery outcome is not
  // safely inferable from status alone. Other 4xx responses reject the send
  // before acceptance and may safely return the review item for correction.
  return error.statusCode >= 400 && error.statusCode < 500 && ![408, 409, 425, 429].includes(error.statusCode);
}

export interface ConversationRecord {
  prospectingOrigin?: { campaign: { id: string; name: string } } | null;
  id: string;
  workspaceId: string;
  channelId: string;
  contactId: string;
  contact?: {
    name?: string | null;
    phone?: string | null;
    isGroup?: boolean;
  } | null;
  channel?: {
    displayName?: string | null;
    phoneNumber?: string | null;
    provider?: string;
    providerKey?: string;
  } | null;
  customerServiceWindowExpiresAt?: DateLike | null;
  department?: {
    name: string;
  } | null;
  assignedUser?: {
    displayName: string;
  } | null;
  status: ConversationDto["status"];
  assignedUserId: string | null;
  departmentId: string | null;
  lastMessageAt: DateLike | null;
  lastMessagePreviewAt?: DateLike | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  hiddenUntilReply?: boolean;
  priority: ConversationDto["priority"];
  aiControlStatus?: NonNullable<ConversationDto["aiControlStatus"]>;
  activeAgentSessionId?: string | null;
  activeAgentSession?: {
    status: NonNullable<ConversationDto["activeAgentSessionStatus"]>;
    handoffReason?: string | null;
    handoffActionCompletedAt?: DateLike | null;
    agent?: {
      name: string;
    } | null;
  } | null;
  inboxTriage?: {
    manualMarkedAt: DateLike | null;
    decision: "needs_reply" | "no_reply" | "uncertain" | null;
    reason: string | null;
    anchorMessageId: string | null;
    dismissedMessageId: string | null;
  } | null;
  tags?: Array<{
    tag: TagRecord;
  }>;
}

export const inboxHandoffWhere: Prisma.ConversationWhereInput = {
  status: { not: "closed" },
  OR: [
    { activeAgentSession: { is: { status: "handoff_requested", handoffActionCompletedAt: null } } },
    {
      aiControlStatus: "human_controlled",
      activeAgentSession: { is: {
        handoffReason: { notIn: [""] }, handoffActionCompletedAt: null
      } }
    }
  ]
};

const inboxSemanticReplyWhere: Prisma.ConversationWhereInput = {
  status: { not: "closed" },
  aiControlStatus: "human_controlled",
  inboxTriage: { is: {
    decision: { in: ["needs_reply", "uncertain"] },
    dismissedMessageId: null,
    anchorMessageId: { not: null }
  } }
};

// In private review modes the autonomous agent is blocked. A ready suggestion or
// generation failure therefore belongs in the seller's reply queue, even after
// the conversation has been opened and its unread counter reached zero.
const privateReviewChannelWhere: Prisma.ConversationWhereInput = {
  channel: { is: { OR: [
    { encryptedConfig: { path: ["assistant", "mode"], equals: "automatic" } },
    { encryptedConfig: { path: ["assistant", "mode"], equals: "on_demand" } }
  ] } }
};

const inboxPrivateReviewWhere: Prisma.ConversationWhereInput = {
  status: { not: "closed" },
  assistantState: { is: { status: { in: ["ready", "failed"] } } },
  ...privateReviewChannelWhere
};

export const inboxUnreadWhere: Prisma.ConversationWhereInput = {
  unreadCount: { gt: 0 },
  OR: [inboxHandoffWhere, { aiControlStatus: "human_controlled" }, privateReviewChannelWhere]
};

export const conversationDtoInclude = {
  prospectingOrigin: { select: { campaign: { select: { id: true, name: true } } } },
  assignedUser: { select: { displayName: true } },
  channel: { select: { displayName: true, phoneNumber: true, provider: true } },
  contact: { select: { name: true, phone: true, isGroup: true } },
  department: { select: { name: true } },
  activeAgentSession: {
    select: {
      status: true,
      handoffReason: true,
      handoffActionCompletedAt: true,
      agent: { select: { name: true } }
    }
  },
  inboxTriage: {
    select: { manualMarkedAt: true, decision: true, reason: true, anchorMessageId: true, dismissedMessageId: true }
  },
  tags: { include: { tag: true } }
} as const;

interface MessageRecord {
  id: string;
  workspaceId: string;
  conversationId: string;
  providerMessageId?: string | null;
  direction: MessageDto["direction"];
  type: MessageDto["type"];
  body: string | null;
  mediaUrl?: string | null;
  metadata?: unknown;
  status: MessageDto["status"];
  sentByUserId?: string | null;
  createdAt: DateLike;
}

interface TagRecord {
  id: string;
  name: string;
  color: string;
}

interface ContactNoteRecord {
  id: string;
  workspaceId: string;
  contactId: string;
  conversationId: string | null;
  body: string;
  createdById: string | null;
  createdAt: DateLike;
  createdBy?: {
    displayName: string;
  } | null;
}

interface BoardStageRecord {
  id: string;
  workspaceId: string;
  boardId: string;
  name: string;
  color: string;
  order: number;
  board?: {
    name: string;
  } | null;
}

interface BoardMembershipRecord {
  id: string;
  workspaceId: string;
  contactId: string;
  boardId: string;
  stageId: string;
  isPrimary: boolean;
  lastMovedBy?: ContactBoardMoveSource | null;
  lastRuleAppliedAt?: DateLike | null;
  updatedAt: DateLike;
  board?: {
    name: string;
  } | null;
  stage?: {
    name: string;
    color: string;
  } | null;
}

interface DepartmentRecord {
  id: string;
  workspaceId: string;
  name: string;
}

interface UserProfileRecord {
  id: string;
  workspaceId: string;
  displayName: string;
}

export interface ContactContextDto {
  primaryBoardStage: {
    membershipId: string;
    boardId: string;
    boardName: string;
    stageId: string;
    stageName: string;
    stageColor: string;
  } | null;
  tags: TagRecord[];
  notes: Array<{
    id: string;
    body: string;
    createdAt: string;
    createdByName: string | null;
  }>;
  departments: Array<{
    id: string;
    name: string;
  }>;
  boardStages: Array<{
    id: string;
    boardId: string;
    boardName: string;
    name: string;
    color: string;
    order: number;
  }>;
}

type ConversationAction =
  | { action: "add_note"; body: string }
  | { action: "assign_current_user" }
  | { action: "change_department"; departmentId: string | null }
  | { action: "change_priority"; priority: ConversationDto["priority"] }
  | { action: "change_primary_board_stage"; stageId: string }
  | { action: "add_tag"; name: string }
  | { action: "remove_tag"; tagId: string }
  | { action: "request_ai_suggestion" }
  | { action: "create_crm_note" }
  | { action: "close_conversation" };

export interface ConversationActionResultDto {
  conversation: ConversationDto;
  context: ContactContextDto;
  boardMembership?: ContactBoardMembershipDto;
  appliedTag?: {
    conversationId: string;
    tagId: string;
  };
  aiSuggestion?: string;
  crmAction?: {
    id: string;
    status: string;
  };
}

type ConversationFindManyArgs = Parameters<PrismaClient["conversation"]["findMany"]>[0];
type ConversationFindUniqueArgs = Parameters<PrismaClient["conversation"]["findUnique"]>[0];
type ConversationUpdateArgs = Parameters<PrismaClient["conversation"]["update"]>[0];
type MessageCreateArgs = Parameters<PrismaClient["message"]["create"]>[0];
type MessageFindManyArgs = Parameters<PrismaClient["message"]["findMany"]>[0];
type MessageDeleteManyArgs = Parameters<PrismaClient["message"]["deleteMany"]>[0];
type ConversationFollowupDeleteManyArgs = Parameters<PrismaClient["conversationFollowup"]["deleteMany"]>[0];
type ContactNoteCreateArgs = Parameters<PrismaClient["contactNote"]["create"]>[0];
type ContactNoteFindManyArgs = Parameters<PrismaClient["contactNote"]["findMany"]>[0];
type ContactNoteDeleteManyArgs = Parameters<PrismaClient["contactNote"]["deleteMany"]>[0];
type BoardMembershipFindFirstArgs = Parameters<PrismaClient["contactBoardMembership"]["findFirst"]>[0];
type BoardMembershipUpdateArgs = Parameters<PrismaClient["contactBoardMembership"]["update"]>[0];
type BoardStageFindManyArgs = Parameters<PrismaClient["contactBoardStage"]["findMany"]>[0];
type BoardStageFindFirstArgs = Parameters<PrismaClient["contactBoardStage"]["findFirst"]>[0];
type DepartmentFindManyArgs = Parameters<PrismaClient["department"]["findMany"]>[0];
type DepartmentFindFirstArgs = Parameters<PrismaClient["department"]["findFirst"]>[0];
type UserProfileFindFirstArgs = Parameters<PrismaClient["userProfile"]["findFirst"]>[0];
type TagUpsertArgs = Parameters<PrismaClient["tag"]["upsert"]>[0];
type ConversationTagUpsertArgs = Parameters<PrismaClient["conversationTag"]["upsert"]>[0];
type ConversationTagDeleteManyArgs = Parameters<PrismaClient["conversationTag"]["deleteMany"]>[0];
type AiAgentSessionUpdateArgs = Parameters<PrismaClient["aiAgentSession"]["update"]>[0];
type AiAgentSessionDeleteManyArgs = Parameters<PrismaClient["aiAgentSession"]["deleteMany"]>[0];
type AiAgentPendingReplyDeleteManyArgs = Parameters<PrismaClient["aiAgentPendingReply"]["deleteMany"]>[0];
type AiAgentRunDeleteManyArgs = Parameters<PrismaClient["aiAgentRun"]["deleteMany"]>[0];
type AiActionLogCreateArgs = Parameters<PrismaClient["aiActionLog"]["create"]>[0];
type AiActionLogDeleteManyArgs = Parameters<PrismaClient["aiActionLog"]["deleteMany"]>[0];
type AuditLogCreateArgs = Parameters<PrismaClient["auditLog"]["create"]>[0];
type CrmSyncActionCreateArgs = Parameters<PrismaClient["crmSyncAction"]["create"]>[0];

export interface PrismaLike {
  $queryRaw?: PrismaClient['$queryRaw'];
  canonicalMessageIdentity?: { findMany(args: { where: Record<string, unknown>; select: { messageId: true; rawId: true } }): Promise<Array<{ messageId: string; rawId: string }>> };
  assistantConversationState?: Pick<PrismaClient['assistantConversationState'], 'deleteMany'>;
  assistantSuggestion?: Pick<PrismaClient['assistantSuggestion'], 'deleteMany'>;
  conversation: {
    findMany(args: ConversationFindManyArgs): Promise<ConversationRecord[]>;
    findUnique(args: ConversationFindUniqueArgs): Promise<(Partial<ConversationRecord> & { id: string }) | null>;
    update(args: ConversationUpdateArgs): Promise<ConversationRecord>;
  };
  message: {
    update?(args: Parameters<PrismaClient['message']['update']>[0]): Promise<MessageRecord>;
    create(args: MessageCreateArgs): Promise<MessageRecord>;
    findMany(args: MessageFindManyArgs): Promise<MessageRecord[]>;
    deleteMany(args: MessageDeleteManyArgs): Promise<{ count: number }>;
  };
  conversationFollowup: {
    deleteMany(args: ConversationFollowupDeleteManyArgs): Promise<{ count: number }>;
  };
  contactNote: {
    create(args: ContactNoteCreateArgs): Promise<ContactNoteRecord>;
    findMany(args: ContactNoteFindManyArgs): Promise<ContactNoteRecord[]>;
    deleteMany(args: ContactNoteDeleteManyArgs): Promise<{ count: number }>;
  };
  contactBoardMembership: {
    findFirst(args: BoardMembershipFindFirstArgs): Promise<BoardMembershipRecord | null>;
    update(args: BoardMembershipUpdateArgs): Promise<BoardMembershipRecord>;
    updateMany(args: unknown): Promise<{ count: number }>;
    upsert(args: unknown): Promise<BoardMembershipRecord>;
  };
  contactBoardStage: {
    findMany(args: BoardStageFindManyArgs): Promise<BoardStageRecord[]>;
    findFirst(args: BoardStageFindFirstArgs): Promise<BoardStageRecord | null>;
  };
  department: {
    findMany(args: DepartmentFindManyArgs): Promise<DepartmentRecord[]>;
    findFirst(args: DepartmentFindFirstArgs): Promise<DepartmentRecord | null>;
  };
  userProfile: {
    findFirst(args: UserProfileFindFirstArgs): Promise<UserProfileRecord | null>;
  };
  tag: {
    upsert(args: TagUpsertArgs): Promise<TagRecord>;
  };
  conversationTag: {
    upsert(args: ConversationTagUpsertArgs): Promise<unknown>;
    deleteMany(args: ConversationTagDeleteManyArgs): Promise<{ count: number }>;
  };
  aiAgentSession: {
    update(args: AiAgentSessionUpdateArgs): Promise<unknown>;
    deleteMany(args: AiAgentSessionDeleteManyArgs): Promise<{ count: number }>;
  };
  aiAgentPendingReply: {
    deleteMany(args: AiAgentPendingReplyDeleteManyArgs): Promise<{ count: number }>;
  };
  aiAgentRun: {
    deleteMany(args: AiAgentRunDeleteManyArgs): Promise<{ count: number }>;
  };
  aiActionLog: {
    create(args: AiActionLogCreateArgs): Promise<{ id: string; status: string }>;
    deleteMany(args: AiActionLogDeleteManyArgs): Promise<{ count: number }>;
  };
  auditLog: {
    create(args: AuditLogCreateArgs): Promise<unknown>;
  };
  crmSyncAction: {
    create(args: CrmSyncActionCreateArgs): Promise<{ id: string; status: string }>;
  };
  $transaction(callback: (tx: PrismaLike) => Promise<unknown>): Promise<unknown>;
}

interface ConversationsServiceOptions {
  publicTalkUrl?: string;
  evolution?: EvolutionRuntime;
  meta?: {
    phoneNumberId: string | null;
    client?: Pick<MetaClient, "sendText"> | null;
  } | null;
  metaEvolution?: {
    client?: {
      sendText(input: {
        instanceName: string;
        number: string;
        text: string;
      }): Promise<{ providerMessageId: string | null; raw: unknown }>;
    } | null;
  } | null;
}

export type ConversationOutboundTextDelivery = {
  createPendingOutboundMessage(input: {
    reservedMessageId?: string;
    workspaceId: string;
    conversationId: string;
    body: string;
    sentByUserId: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<{
    message: Pick<MessageDto, "id" | "status"> & Partial<MessageDto>;
    conversation?: ConversationDto;
  }>;
};

function toIsoString(value: DateLike): string;
function toIsoString(value: DateLike | null): string | null;
function toIsoString(value: DateLike | null) {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function toChannelProvider(value: string | undefined): ConversationDto["channelProvider"] {
  return value === "evolution" || value === "meta_cloud" ? value : null;
}

function isFutureDate(value: DateLike | null | undefined) {
  if (!value) return false;

  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

/**
 * Each conversation's latest visible message (who sent it, its status), for WhatsApp's ticks on the queue card.
 * One query per page, one index probe per conversation (LATERAL ... LIMIT 1). A failure leaves the cards without ticks.
 */
export async function withLastMessages(prisma: Pick<PrismaLike, '$queryRaw'>, workspaceId: string, dtos: ConversationDto[]): Promise<ConversationDto[]> {
  if (!dtos.length || typeof prisma.$queryRaw !== 'function') return dtos;
  try {
    const rows = await prisma.$queryRaw<Array<{ conversation_id: string; id: string; direction: string; status: string; created_at: Date;
      type: string; body: string | null; mime_type: string | null; media_mime: string | null; sender_name: string | null }>>`
      SELECT c.id::text AS conversation_id, m.id::text AS id, m.direction::text AS direction, m.status::text AS status, m.created_at,
        m.type::text AS type, m.body, m.mime_type,
        substring(m.media_url from '^data:([^;,]+)') AS media_mime, m.sender_name
      FROM unnest(${dtos.map(dto => dto.id)}::uuid[]) AS c(id)
      CROSS JOIN LATERAL (
        SELECT id, direction, status, created_at, type, left(body, 64) AS body,
          metadata->'attachment'->>'mimeType' AS mime_type, left(media_url, 64) AS media_url,
          left(coalesce(nullif(trim(metadata->'groupSender'->>'name'), ''), split_part(metadata->'groupSender'->>'jid', '@', 1)), 120) AS sender_name FROM messages
        WHERE workspace_id = ${workspaceId} AND conversation_id = c.id
          AND NOT (status = 'pending' AND metadata->>'source' = 'followup_review')
        ORDER BY created_at DESC, id DESC LIMIT 1
      ) m`;
    const latest = new Map(rows.map(row => [row.conversation_id, {
      id: row.id, direction: row.direction, status: row.status, createdAt: toIsoString(row.created_at),
      kind: lastMessageKind({ type: row.type, body: row.body, mimeType: row.mime_type ?? row.media_mime }),
      ...(row.direction === 'inbound' && row.sender_name ? { senderName: row.sender_name } : {})
    } as ConversationLastMessage]));
    return dtos.map(dto => ({ ...dto, lastMessage: latest.get(dto.id) ?? null }));
  } catch {
    return dtos;
  }
}

export function toConversationDto(record: ConversationRecord): ConversationDto {
  const channelProvider = toChannelProvider(record.channel?.provider);
  const isGroup = Boolean(record.contact?.isGroup || record.contact?.phone?.endsWith('@g.us'));
  const customerServiceWindowExpiresAt = record.customerServiceWindowExpiresAt
    ? toIsoString(record.customerServiceWindowExpiresAt)
    : null;

  return {
    id: record.id,
    workspaceId: record.workspaceId,
    channelId: record.channelId,
    contactId: record.contactId,
    contactName: record.contact?.name ?? null,
    contactPhone: isGroup ? null : record.contact?.phone ?? null,
    isGroup,
    channelName: record.channel?.displayName ?? record.channel?.phoneNumber ?? null,
    channelProvider,
    customerServiceWindowExpiresAt,
    metaServiceWindowOpen:
      channelProvider === "meta_cloud" ? isFutureDate(record.customerServiceWindowExpiresAt) : null,
    departmentName: record.department?.name ?? null,
    assignedUserName: record.assignedUser?.displayName ?? null,
    status: record.status,
    assignedUserId: record.assignedUserId,
    departmentId: record.departmentId,
    lastMessageAt: record.lastMessageAt ? toIsoString(record.lastMessageAt) : null,
    lastMessagePreviewAt: record.lastMessagePreviewAt ? toIsoString(record.lastMessagePreviewAt) : null,
    lastMessagePreview: record.lastMessagePreview,
    unreadCount: record.unreadCount,
    hiddenUntilReply: Boolean(record.hiddenUntilReply),
    priority: record.priority,
    aiControlStatus: record.aiControlStatus ?? "agent_allowed",
    ...(record.prospectingOrigin !== undefined ? { sourceCampaign: record.prospectingOrigin?.campaign ?? null } : {}),
    activeAgentName: record.activeAgentSession?.agent?.name ?? null,
    activeAgentSessionStatus: record.activeAgentSession?.status ?? null,
    handoffReason: record.activeAgentSession?.handoffReason ?? null,
    handoffActionCompletedAt: record.activeAgentSession?.handoffActionCompletedAt
      ? toIsoString(record.activeAgentSession.handoffActionCompletedAt)
      : null,
    ...(record.inboxTriage !== undefined ? {
      manualMarked: Boolean(record.inboxTriage?.manualMarkedAt),
      replyTriageDecision: record.inboxTriage?.decision ?? null,
      replyTriageReason: record.inboxTriage?.reason ?? null,
      replyTriageAnchorMessageId: record.inboxTriage?.anchorMessageId ?? null,
      replyDismissed: Boolean(record.inboxTriage?.anchorMessageId &&
        record.inboxTriage.dismissedMessageId === record.inboxTriage.anchorMessageId)
    } : {})
  };
}

export function toMessageDto(record: MessageRecord): MessageDto {
  return mapMessageDto(record);
}

export function toCompactMessageDto(record: MessageRecord, publicTalkUrl: string): MessageDto {
  return mapMessageDto(record, publicTalkUrl);
}

function canonicalInlineBase64(source: string, headerLength: number): boolean {
  const length = source.length - headerLength;
  if (!length || length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(source.slice(headerLength))) return false;
  const padding = source.endsWith('==') ? 2 : source.endsWith('=') ? 1 : 0;
  const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(source[source.length - padding - 1]);
  return padding === 0 || last % (padding === 2 ? 16 : 4) === 0;
}

function mapMessageDto(record: MessageRecord, publicTalkUrl?: string): MessageDto {
  const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const metadata = object(record.metadata);
  const cache = object(metadata.assistantMedia);
  const sourceHash = createHash('sha256').update(JSON.stringify([record.id, record.type, record.mediaUrl ?? null])).digest('hex');
  const result = cache.sourceHash === sourceHash ? object(cache.result) : {};
  const history = object(metadata.historyImport);
  const attachment = object(metadata.attachment);
  const inlineHeader = /^data:([^;,]+);base64,/i.exec(record.mediaUrl ?? '');
  const storedVisual = record.type === 'image' && /^image\/(jpeg|png|webp|gif)$/i.test(inlineHeader?.[1] ?? '') ||
    record.type === 'file' && /^video\/(mp4|webm|quicktime)$/i.test(inlineHeader?.[1] ?? '');
  // Preserve direct display above the frontend's 64 MiB Blob cache budget.
  const inlineBytes = inlineHeader ? (record.mediaUrl!.length - inlineHeader[0].length) * 3 / 4 - (record.mediaUrl!.endsWith('==') ? 2 : record.mediaUrl!.endsWith('=') ? 1 : 0) : 0;
  const compactMedia = Boolean(publicTalkUrl && ['image', 'audio', 'file'].includes(record.type) && record.mediaUrl?.startsWith('data:') && inlineHeader &&
    (!storedVisual || inlineBytes <= 64 * 1024 * 1024 && canonicalInlineBase64(record.mediaUrl, inlineHeader[0].length)));
  const sourceMimeType = compactMedia ? /^data:([^;,]{1,120})[;,]/i.exec(record.mediaUrl!)?.[1].trim().toLowerCase() : undefined;
  const inferredMimeType = typeof attachment.mimeType !== 'string' ? sourceMimeType : undefined;
  // The inline URL used to identify video/PDF even with generic provider MIME
  // metadata. Keep that presentation hint without replacing existing metadata.
  const previewMimeType = sourceMimeType && typeof attachment.mimeType === 'string' && attachment.mimeType.toLowerCase() !== sourceMimeType &&
    (sourceMimeType.startsWith('video/') || sourceMimeType === 'application/pdf') ? sourceMimeType : undefined;
  const groupSender = object(metadata.groupSender);
  const location = messageLocationSchema.safeParse(metadata.location);
  const rawCards = Array.isArray(metadata.contactCards) ? metadata.contactCards : metadata.contactCard ? [metadata.contactCard] : [];
  const contactCards = rawCards.slice(0, 50).map((raw) => {
    const card = object(raw);
    const fullName = typeof card.fullName === 'string' ? card.fullName.trim().slice(0, 200) : '';
    const phoneNumber = typeof card.phoneNumber === 'string' ? card.phoneNumber.replace(/\D/g, '').slice(0, 20) : null;
    return fullName ? { fullName, phoneNumber: phoneNumber || null } : null;
  }).filter((card): card is { fullName: string; phoneNumber: string | null } => Boolean(card));
  const publicAttachment = {
    ...(typeof attachment.fileName === 'string' ? { fileName: attachment.fileName.slice(0, 240) } : {}),
    ...(typeof attachment.caption === 'string' ? { caption: attachment.caption } : {}),
    ...(typeof attachment.mimeType === 'string' ? { mimeType: attachment.mimeType } : inferredMimeType ? { mimeType: inferredMimeType } : {}),
    ...(typeof attachment.durationSeconds === 'number' && Number.isFinite(attachment.durationSeconds) && attachment.durationSeconds >= 0 ? { durationSeconds: attachment.durationSeconds } : {}),
    ...(attachment.isGif === true ? { isGif: true } : {}),
    ...(typeof attachment.width === 'number' && attachment.width > 0 && typeof attachment.height === 'number' && attachment.height > 0
      ? { width: attachment.width, height: attachment.height } : {})
  };
  const processed = result.status === 'processed' && typeof result.extractedText === 'string' && result.extractedText.trim().length > 0;
  const unread = ['image', 'audio', 'file'].includes(record.type) && !processed && (result.status === 'failed' || (history.source === 'evolution' && ['unavailable', 'unread'].includes(String(history.mediaStatus))));
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    conversationId: record.conversationId,
    providerMessageId: record.providerMessageId ?? null,
    direction: record.direction,
    type: record.type,
    body: record.body,
    ...(groupSender.name || groupSender.jid ? {
      senderName: typeof groupSender.name === 'string' ? groupSender.name.slice(0, 120) : null,
      senderJid: typeof groupSender.jid === 'string' ? groupSender.jid.slice(0, 100) : null
    } : {}),
    mediaUrl: compactMedia ? new URL(`/api/conversations/${encodeURIComponent(record.conversationId)}/messages/${encodeURIComponent(record.id)}/media?v=${sourceHash}${previewMimeType ? `&previewMime=${encodeURIComponent(previewMimeType)}` : ''}`, publicTalkUrl).href : record.mediaUrl ?? null,
    ...(record.mediaUrl && ['image', 'audio', 'file'].includes(record.type) ? { mediaSourceHash: sourceHash } : {}),
    ...(contactCards.length ? { contactCards } : {}),
    ...(location.success ? { location: location.data } : {}),
    ...(Object.keys(publicAttachment).length ? { attachment: publicAttachment } : {}),
    ...(unread ? { attachmentReadStatus: 'unread' as const } : {}),
    status: record.status,
    sentByUserId: record.sentByUserId ?? null,
    ...(typeof metadata.editedAt === 'string' ? { editedAt: metadata.editedAt } : {}),
    ...(typeof metadata.deletedAt === 'string' ? { deletedAt: metadata.deletedAt } : {}),
    ...(metadata.supervisorReply && typeof metadata.supervisorReply === 'object' ? { sentBySupervisor: true } : {}),
    ...(metadata.forwarded && typeof metadata.forwarded === 'object' ? { forwarded: true } : {}),
    ...whatsappPresentation(metadata, record.providerMessageId ?? null),
    createdAt: toIsoString(record.createdAt)
  };
}

/** WhatsApp id, quote and reaction stored by the canonical writer (metadata.whatsapp/quoted/reaction). */
function whatsappPresentation(metadata: Record<string, unknown>, providerMessageId: string | null) {
  const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const text = (v: unknown, max: number) => typeof v === 'string' && v ? v.slice(0, max) : null;
  const whatsapp = object(metadata.whatsapp), quoted = object(metadata.quoted), reaction = object(metadata.reaction);
  const whatsappId = text(whatsapp.id, 200) ?? (providerMessageId && !providerMessageId.includes('_') && !providerMessageId.startsWith('wamid.') ? providerMessageId : null);
  return {
    ...(whatsappId ? { whatsappId } : {}),
    ...(text(quoted.id, 200) ? { quoted: { whatsappId: text(quoted.id, 200)!, participant: text(quoted.participant, 100), body: text(quoted.body, 500) } } : {}),
    ...(text(reaction.targetId, 200) ? { reaction: { targetWhatsappId: text(reaction.targetId, 200)!, emoji: text(reaction.emoji, 32) } } : {})
  };
}

function toNoteDto(record: ContactNoteRecord): ContactContextDto["notes"][number] {
  return {
    id: record.id,
    body: record.body,
    createdAt: toIsoString(record.createdAt),
    createdByName: record.createdBy?.displayName ?? null
  };
}

function toPrimaryBoardStageDto(
  record: BoardMembershipRecord | null
): ContactContextDto["primaryBoardStage"] {
  if (!record) return null;

  return {
    membershipId: record.id,
    boardId: record.boardId,
    boardName: record.board?.name ?? "Board",
    stageId: record.stageId,
    stageName: record.stage?.name ?? "Etapa",
    stageColor: record.stage?.color ?? "#24564a"
  };
}

function toBoardMembershipDto(record: BoardMembershipRecord): ContactBoardMembershipDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    contactId: record.contactId,
    boardId: record.boardId,
    stageId: record.stageId,
    isPrimary: record.isPrimary,
    lastMovedBy: record.lastMovedBy ?? "manual",
    lastRuleAppliedAt: toIsoString(record.lastRuleAppliedAt ?? null),
    updatedAt: toIsoString(record.updatedAt)
  };
}

function toBoardStageOptionDto(record: BoardStageRecord): ContactContextDto["boardStages"][number] {
  return {
    id: record.id,
    boardId: record.boardId,
    boardName: record.board?.name ?? "Board",
    name: record.name,
    color: record.color,
    order: record.order
  };
}

function assertConversationRecord(
  record: (Partial<ConversationRecord> & { id: string }) | null
): asserts record is ConversationRecord {
  if (!record || !record.workspaceId || !record.contactId) {
    throw new ConversationNotFoundError();
  }
}

export function createConversationsService(
  prisma: PrismaLike,
  options: ConversationsServiceOptions = {}
) {
  type ConversationListStatus = "active" | "closed" | "all";
  const activeConversationStatuses: ConversationStatus[] = ["open", "pending"];

  function conversationListWhere(input: {
    workspaceId: string;
    status?: ConversationListStatus;
    assignedUserId?: string | null;
    channelId?: string;
    search?: string;
    view?: InboxView;
  }): Prisma.ConversationWhereInput {
    const assigneeWhere = input.assignedUserId ? { assignedUserId: input.assignedUserId } : {};
    const channelWhere = input.channelId ? { channelId: input.channelId } : {};
    const searchPhone = input.search?.replace(/\D/g, '')
      ? canonicalizePhone(input.search)
      : input.search?.trim() ?? '';
    const searchWhere: Prisma.ConversationWhereInput = input.search?.trim()
      ? { contact: { is: { OR: [
          { name: { contains: input.search.trim(), mode: "insensitive" } },
          { phone: { contains: searchPhone } }
        ] } } }
      : {};
    // A conversation retired by an authority resolution is never listed: its chat is operated, and shown, by another one.
    const visibilityWhere: Prisma.ConversationWhereInput = input.search?.trim()
      ? { retiredIntoConversationId: null } : { hiddenUntilReply: false, retiredIntoConversationId: null };
    const viewWhere: Prisma.ConversationWhereInput = input.view === "unread"
      ? inboxUnreadWhere
      : input.view === "marked"
        ? { inboxTriage: { is: { manualMarkedAt: { not: null } } } }
        : input.view === "reply"
          ? { OR: [inboxHandoffWhere, inboxSemanticReplyWhere, inboxPrivateReviewWhere] }
          : input.view === "handoff" ? inboxHandoffWhere : {};
    if (input.status === "closed") {
      return {
        workspaceId: input.workspaceId,
        status: "closed" as const,
        ...assigneeWhere,
        ...channelWhere,
        ...visibilityWhere,
        ...searchWhere,
        ...viewWhere
      };
    }

    if (input.status === "all") {
      return {
        workspaceId: input.workspaceId,
        ...assigneeWhere,
        ...channelWhere,
        ...visibilityWhere,
        ...searchWhere,
        ...viewWhere
      };
    }

    return {
      workspaceId: input.workspaceId,
      status: { in: activeConversationStatuses },
      ...assigneeWhere,
      ...channelWhere,
      ...visibilityWhere,
      ...searchWhere,
      ...viewWhere
    };
  }

  async function findConversation(input: {
    workspaceId: string;
    conversationId: string;
  }): Promise<ConversationRecord> {
    const conversation = await prisma.conversation.findUnique({
      where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
      include: conversationDtoInclude
    });

    assertConversationRecord(conversation);
    return conversation;
  }

  async function buildContactContext(conversation: ConversationRecord): Promise<ContactContextDto> {
    const [primaryMembership, notes, departments, boardStages] = await Promise.all([
      prisma.contactBoardMembership.findFirst({
        where: {
          workspaceId: conversation.workspaceId,
          contactId: conversation.contactId,
          isPrimary: true
        },
        include: {
          board: { select: { name: true } },
          stage: { select: { name: true, color: true } }
        },
        orderBy: { updatedAt: "desc" }
      }),
      prisma.contactNote.findMany({
        where: {
          workspaceId: conversation.workspaceId,
          contactId: conversation.contactId
        },
        include: {
          createdBy: { select: { displayName: true } }
        },
        orderBy: { createdAt: "desc" },
        take: 5
      }),
      prisma.department.findMany({
        where: { workspaceId: conversation.workspaceId },
        orderBy: [{ routingOrder: "asc" }, { name: "asc" }],
        take: 50
      }),
      prisma.contactBoardStage.findMany({
        where: { workspaceId: conversation.workspaceId },
        include: {
          board: { select: { name: true } }
        },
        orderBy: [{ boardId: "asc" }, { order: "asc" }]
      })
    ]);

    return measureInboxAssembly(() => ({
      primaryBoardStage: toPrimaryBoardStageDto(primaryMembership),
      tags: conversation.tags?.map((tagLink) => tagLink.tag) ?? [],
      notes: notes.map(toNoteDto),
      departments: departments.map((department) => ({
        id: department.id,
        name: department.name
      })),
      boardStages: boardStages.map(toBoardStageOptionDto)
    }));
  }

  async function resolveCurrentUser(input: {
    workspaceId: string;
    currentClerkUserId?: string | null;
  }): Promise<UserProfileRecord> {
    if (!input.currentClerkUserId) {
      throw new ConversationActionError(
        "CURRENT_USER_REQUIRED",
        "Current user identity is required for assignment."
      );
    }

    const user = await prisma.userProfile.findFirst({
      where: {
        workspaceId: input.workspaceId,
        clerkUserId: input.currentClerkUserId
      }
    });

    if (!user) {
      throw new ConversationActionError(
        "CURRENT_USER_NOT_FOUND",
        "Current user profile was not found in this workspace."
      );
    }

    return user;
  }

  return {
    async getConversationDto(input: { workspaceId: string; conversationId: string }): Promise<ConversationDto> {
      const [dto] = await withLastMessages(prisma, input.workspaceId, [toConversationDto(await findConversation(input))]);
      return dto!;
    },
    async listConversations(input: {
      workspaceId: string;
      status?: ConversationListStatus;
      assignedUserId?: string | null;
      channelId?: string;
      search?: string;
      cursor?: string;
      view?: InboxView;
    }): Promise<ConversationDto[]> {
      const conversations = await prisma.conversation.findMany({
        where: conversationListWhere(input),
        include: conversationDtoInclude,
        orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }, { id: "desc" }],
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        take: 50
      });

      return withLastMessages(prisma, input.workspaceId, measureInboxAssembly(() => conversations.map(toConversationDto)));
    },

    async createPendingOutboundMessage(input: {
      reservedMessageId?: string;
      workspaceId: string;
      conversationId: string;
      body?: string;
      attachment?: {
        fileName: string;
        mimetype: string;
        mediaUrl: string;
      };
      contactCard?: { fullName: string; phoneNumber: string };
      sentByUserId: string | null;
      metadata?: Record<string, unknown>;
      /** Reply to this message (text only). */
      quoted?: { id: string; fromMe: boolean; participant: string | null; body: string | null };
    }): Promise<{ message: MessageDto; conversation: ConversationDto }> {
      if (input.reservedMessageId && !prisma.message.update) throw new Error('Reserved outbound storage is unavailable.');
      const conversation = await prisma.conversation.findUnique({
        where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
        select: {
          customerServiceWindowExpiresAt: true,
          id: true,
          channel: { select: { provider: true, providerKey: true } },
          contact: { select: { phone: true, isGroup: true } }
        }
      });

      if (!conversation) {
        throw new ConversationNotFoundError();
      }

      if (input.contactCard && (conversation.contact?.isGroup || conversation.contact?.phone?.endsWith('@g.us'))) {
        throw new OutboundMessageValidationError('CONTACT_CARD_NOT_SUPPORTED', 'Não é possível compartilhar um contato em uma conversa de grupo.');
      }

      const isAudio = input.attachment?.mimetype.toLowerCase().startsWith('audio/') ?? false;
      if (isAudio && conversation.channel?.provider !== 'evolution') throw new OutboundMessageValidationError('AUDIO_CHANNEL_NOT_SUPPORTED', 'A gravação de voz está disponível em canais Evolution.');
      let audio: Awaited<ReturnType<typeof prepareVoiceRecording>> | null = null;
      const isVideo = input.attachment?.mimetype.toLowerCase().startsWith('video/') ?? false;
      const messageBody = isAudio ? 'Áudio enviado' : input.contactCard
        ? `Contato compartilhado: ${input.contactCard.fullName} (${input.contactCard.phoneNumber})`
        : input.body?.trim() || (isVideo ? 'Vídeo enviado' : input.attachment?.fileName) || "";
      const messageType: MessageDto["type"] = input.attachment
        ? isAudio ? 'audio' : input.attachment.mimetype.toLowerCase().startsWith("image/")
          ? "image"
          : "file"
        : "text";

      const prospecting = input.metadata?.source === 'ai_agent' ? await findProspectingReservation(prisma, input.workspaceId, input.conversationId) : null;
      const prospectingPending = prospecting ? input.reservedMessageId ? await adoptProspectingOutbound(prisma, {
        workspaceId: input.workspaceId, conversationId: input.conversationId, messageId: input.reservedMessageId, agentId: prospecting.agentId,
        generation: typeof input.metadata?.prospectingGeneration === 'string' ? input.metadata.prospectingGeneration : prospecting.generation,
        type: messageType === 'image' ? 'image' : messageType === 'file' ? 'file' : 'text', body: messageBody, mediaUrl: input.attachment?.mediaUrl, metadata: input.metadata
      }) : await reserveProspectingOutbound(prisma, {
        workspaceId: input.workspaceId, conversationId: input.conversationId, agentId: prospecting.agentId,
        generation: typeof input.metadata?.prospectingGeneration === 'string' ? input.metadata.prospectingGeneration : prospecting.generation,
        type: messageType === 'image' ? 'image' : messageType === 'file' ? 'file' : 'text', body: messageBody,
        mediaUrl: input.attachment?.mediaUrl, metadata: input.metadata }) : null;
      const reservedMessageId = prospectingPending?.id ?? input.reservedMessageId;
      let providerSend: { providerMessageId: string | null; raw: unknown } | null = null;
      let providerStarted = false;
      let confirmedProspectingMessage: Awaited<ReturnType<typeof dispatchProspectingOutbound>> | null = null;
      const callProvider = async (operation: () => Promise<{ providerMessageId: string | null; raw: unknown }>) => {
        if (input.metadata?.source === "ai_agent" && await findProspectingReservation(prisma, input.workspaceId, input.conversationId) && !await autonomousAgentAllowed(prisma, { workspaceId: input.workspaceId, conversationId: input.conversationId, agentId: typeof input.metadata.agentId === "string" ? input.metadata.agentId : undefined, expectedGeneration: typeof input.metadata.prospectingGeneration === "string" ? input.metadata.prospectingGeneration : undefined })) { if (prospectingPending) await cancelProspectingOutbound(prisma, prospectingPending.id); throw new Error("Prospecting authorization changed before delivery."); }
        try {
          if (prospectingPending) {
            confirmedProspectingMessage = await dispatchProspectingOutbound(prisma, prospectingPending, async () => {
              providerStarted = true;
              return operation();
            });
            return { providerMessageId: confirmedProspectingMessage.providerMessageId, raw: null };
          }
          providerStarted = true;
          return await operation();
        } catch (error) {
          if (reservedMessageId && providerStarted && !isDefinitiveProviderRejection(error)) {
            throw new OutboundDeliveryUncertainError();
          }
          throw error;
        }
      };

      if (
        options.evolution?.mode === "real" &&
        options.evolution.client &&
        conversation.channel?.provider === "evolution"
      ) {
        const contactPhone = conversation.contact?.phone?.trim();
        const providerKey = conversation.channel.providerKey?.trim();

        if (!contactPhone) {
          throw new OutboundMessageValidationError(
            "OUTBOUND_CONTACT_PHONE_REQUIRED",
            "Contact phone is required to send an Evolution message."
          );
        }

        if (!providerKey) {
          throw new OutboundMessageValidationError(
            "OUTBOUND_PROVIDER_KEY_REQUIRED",
            "Evolution provider key is required to send a message."
          );
        }

        if (input.contactCard) {
          if (!options.evolution.client.sendContact) throw new OutboundMessageValidationError('CONTACT_CARD_NOT_SUPPORTED', 'Este canal não oferece cartão de contato.');
          providerSend = await callProvider(() => options.evolution!.client!.sendContact!({
            instanceName: providerKey,
            number: contactPhone,
            contact: [{
              fullName: input.contactCard!.fullName,
              wuid: input.contactCard!.phoneNumber,
              phoneNumber: input.contactCard!.phoneNumber
            }]
          }));
        } else if (isAudio && input.attachment) {
          if (!options.evolution.client.sendAudio) throw new OutboundMessageValidationError('AUDIO_CHANNEL_NOT_SUPPORTED', 'Este canal ainda não oferece envio de voz.');
          try { audio = await prepareVoiceRecording(input.attachment.mediaUrl, input.attachment.mimetype); }
          catch (e) { throw new OutboundMessageValidationError('INVALID_VOICE_RECORDING', e instanceof Error ? e.message : 'Áudio inválido.'); }
          providerSend = await callProvider(() => options.evolution!.client!.sendAudio!({ instanceName: providerKey, number: contactPhone, audio: audio!.mediaUrl }));
        } else {
          const attachment = input.attachment;
          providerSend = attachment
          ? await callProvider(() => options.evolution!.client!.sendMedia({
              instanceName: providerKey,
              number: contactPhone,
              mediatype: messageType === "image" ? "image" : isVideo ? "video" : "document",
              mimetype: attachment.mimetype,
              media: attachment.mediaUrl,
              fileName: attachment.fileName,
              caption: input.body
            }))
          : await callProvider(() => options.evolution!.client!.sendText({
              instanceName: providerKey,
              number: contactPhone,
              text: messageBody,
              ...(input.quoted ? { quoted: input.quoted } : {})
            }));
        }
      }

      if (conversation.channel?.provider === "meta_cloud") {
        const contactPhone = conversation.contact?.phone?.trim();
        const providerKey = conversation.channel.providerKey?.trim();
        const phoneNumberId = options.meta?.phoneNumberId?.trim();
        const metaClient = options.meta?.client;
        const metaEvolutionClient = options.metaEvolution?.client;

        if (input.attachment || input.contactCard) {
          throw new OutboundMessageValidationError(
            input.contactCard ? "CONTACT_CARD_NOT_SUPPORTED" : "META_MEDIA_NOT_SUPPORTED",
            "Meta Cloud inbox replies support text only in this release."
          );
        }

        if (!contactPhone) {
          throw new OutboundMessageValidationError(
            "OUTBOUND_CONTACT_PHONE_REQUIRED",
            "Contact phone is required to send a Meta Cloud message."
          );
        }

        if (metaEvolutionClient && providerKey) {
          if (!isFutureDate(conversation.customerServiceWindowExpiresAt)) {
            throw new OutboundMessageValidationError(
              "META_SERVICE_WINDOW_CLOSED",
              "The Meta customer service window is closed. An approved Meta template is required."
            );
          }

          providerSend = await callProvider(() => metaEvolutionClient.sendText({
            instanceName: providerKey,
            number: contactPhone,
            text: messageBody
          }));
        } else if (!metaClient || !phoneNumberId) {
          throw new OutboundMessageValidationError(
            "META_NOT_CONFIGURED",
            "Meta Cloud is not configured for this workspace."
          );
        } else {
          if (!isFutureDate(conversation.customerServiceWindowExpiresAt)) {
            throw new OutboundMessageValidationError(
              "META_SERVICE_WINDOW_CLOSED",
              "The Meta customer service window is closed. An approved Meta template is required."
            );
          }

          providerSend = await callProvider(() => metaClient.sendText({
            phoneNumberId,
            to: contactPhone,
            text: messageBody
          }));
        }
      }

      const messageData = {
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          direction: "outbound" as const,
          type: messageType,
          body: messageBody,
          mediaUrl: audio?.mediaUrl ?? input.attachment?.mediaUrl,
          ...(audio || input.attachment || input.metadata || input.contactCard || input.quoted
            ? {
                metadata: {
                  ...(audio
                    ? { attachment: { fileName: "audio.ogg", mimeType: 'audio/ogg', durationSeconds: audio.durationSeconds } }
                    : input.attachment ? { attachment: { fileName: input.attachment.fileName, mimeType: input.attachment.mimetype,
                      ...(input.body?.trim() ? { caption: input.body.trim() } : {}) } } : {}),
                  ...(input.metadata ?? {}),
                  ...(input.contactCard ? { contactCard: input.contactCard } : {}),
                  ...(input.quoted && !input.attachment ? { quoted: { id: input.quoted.id, participant: input.quoted.participant, body: input.quoted.body } } : {})
                } as Prisma.InputJsonValue
              }
            : {}),
          providerMessageId: providerSend?.providerMessageId ?? undefined,
          status: providerSend ? "sent" as const : "pending" as const,
          sentByUserId: input.sentByUserId
      };
      try {
        const message = prospectingPending ? confirmedProspectingMessage ?? await confirmProspectingOutbound(prisma, prospectingPending.id, providerSend?.providerMessageId) : reservedMessageId
          ? await prisma.message.update!({ where: { workspaceId_id: { workspaceId: input.workspaceId, id: reservedMessageId } }, data: messageData })
          : await prisma.message.create({ data: messageData });

        const updatedConversation = await prisma.conversation.update({
          where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
          data: {
            lastMessageAt:
              message.createdAt instanceof Date ? message.createdAt : new Date(message.createdAt),
            lastMessagePreview: messageBody
          },
          include: conversationDtoInclude
        });

        return {
          message: toMessageDto(message),
          conversation: toConversationDto(updatedConversation)
        };
      } catch (error) {
        if (input.reservedMessageId && providerStarted) throw new OutboundDeliveryUncertainError();
        throw error;
      }
    },

    async markConversationRead(input: {
      workspaceId: string;
      conversationId: string;
    }): Promise<ConversationDto> {
      const conversation = await prisma.conversation.update({
        where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
        data: { unreadCount: 0 },
        include: conversationDtoInclude
      }).catch((error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "P2025"
        ) {
          throw new ConversationNotFoundError();
        }

        throw error;
      });

      return toConversationDto(conversation);
    },

    async updateAiControl(input: {
      workspaceId: string;
      conversationId: string;
      status: NonNullable<ConversationDto["aiControlStatus"]>;
      actorUserId?: string | null;
    }): Promise<ConversationDto> {
      const conversation = await prisma.conversation.findUnique({
        where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
        select: {
          id: true,
          workspaceId: true,
          contactId: true,
          activeAgentSessionId: true
        }
      });

      assertConversationRecord(conversation);

      const aiControlUpdatedAt = new Date();
      const updatedConversation = (await prisma.$transaction(async (tx) => {
        await lockProspectingConversation(tx, input.workspaceId, input.conversationId);
        if (input.status === "human_controlled") await stopProspectingConversation(tx, input.workspaceId, input.conversationId, "human_controlled");
        if (input.status === "human_controlled" && conversation.activeAgentSessionId) {
          await tx.aiAgentSession.update({
            where: {
              workspaceId_id: {
                workspaceId: input.workspaceId,
                id: conversation.activeAgentSessionId
              }
            },
            data: {
              status: "paused_by_human"
            }
          });
        }

        return tx.conversation.update({
          where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
          data: {
            aiControlStatus: input.status,
            aiControlUpdatedAt,
            aiControlUpdatedById: input.actorUserId ?? null
          },
          include: conversationDtoInclude
        });
      })) as ConversationRecord;

      return toConversationDto(updatedConversation);
    },

    async updateHandoffAction(input: {
      workspaceId: string;
      conversationId: string;
      completed?: boolean;
      actorUserId?: string | null;
    }): Promise<ConversationDto> {
      if (input.completed === undefined) {
        return toConversationDto(await findConversation(input));
      }
      const updatedConversation = (await prisma.$transaction(async (tx) => {
        const current = await tx.conversation.findUnique({
          where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
          include: conversationDtoInclude
        });
        assertConversationRecord(current);
        if (
          !current.activeAgentSessionId ||
          !current.activeAgentSession?.handoffReason ||
          !["handoff_requested", "paused_by_human"].includes(current.activeAgentSession.status)
        ) {
          throw new ConversationActionError(
            "HANDOFF_ACTION_NOT_AVAILABLE",
            "Não há uma próxima ação humana para concluir nesta conversa."
          );
        }

        if (input.completed !== undefined) {
          await tx.aiAgentSession.update({
            where: { workspaceId_id: { workspaceId: input.workspaceId, id: current.activeAgentSessionId } },
            data: { handoffActionCompletedAt: input.completed ? new Date() : null }
          });
        }
        if (input.completed && current.aiControlStatus !== "human_controlled") {
          await tx.conversation.update({
            where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
            data: {
              aiControlStatus: "human_controlled",
              aiControlUpdatedAt: new Date(),
              aiControlUpdatedById: input.actorUserId ?? null
            }
          });
        }
        return tx.conversation.findUnique({
          where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
          include: conversationDtoInclude
        });
      })) as ConversationRecord | null;
      assertConversationRecord(updatedConversation);
      return toConversationDto(updatedConversation);
    },

    async getContactContext(input: {
      workspaceId: string;
      conversationId: string;
    }): Promise<ContactContextDto> {
      const conversation = await findConversation(input);
      return buildContactContext(conversation);
    },

    async runConversationAction(input: {
      workspaceId: string;
      conversationId: string;
      currentClerkUserId?: string | null;
    } & ConversationAction): Promise<ConversationActionResultDto> {
      let conversation = await findConversation(input);
      let aiSuggestion: string | undefined;
      let crmAction: ConversationActionResultDto["crmAction"];
      let boardMembership: ContactBoardMembershipDto | undefined;
      let appliedTag: ConversationActionResultDto["appliedTag"];

      if (input.action === "add_note") {
        const user = input.currentClerkUserId
          ? await prisma.userProfile.findFirst({
              where: {
                workspaceId: input.workspaceId,
                clerkUserId: input.currentClerkUserId
              }
            })
          : null;

        await prisma.contactNote.create({
          data: {
            workspaceId: input.workspaceId,
            contactId: conversation.contactId,
            conversationId: input.conversationId,
            body: input.body.trim(),
            createdById: user?.id ?? null
          },
          include: {
            createdBy: { select: { displayName: true } }
          }
        });
      }

      if (input.action === "assign_current_user") {
        await stopProspectingConversation(prisma, input.workspaceId, input.conversationId, "human_assignment");
        const user = await resolveCurrentUser(input);

        conversation = await prisma.conversation.update({
          where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
          data: { assignedUserId: user.id },
          include: {
            assignedUser: { select: { displayName: true } },
            channel: { select: { displayName: true, phoneNumber: true } },
            contact: { select: { name: true, phone: true } },
            department: { select: { name: true } },
            tags: { include: { tag: true } }
          }
        });
      }

      if (input.action === "change_department") {
        if (input.departmentId) {
          const department = await prisma.department.findFirst({
            where: { workspaceId: input.workspaceId, id: input.departmentId }
          });

          if (!department) {
            throw new ConversationActionError("DEPARTMENT_NOT_FOUND", "Department not found.");
          }
        }

        conversation = await prisma.conversation.update({
          where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
          data: { departmentId: input.departmentId },
          include: {
            assignedUser: { select: { displayName: true } },
            channel: { select: { displayName: true, phoneNumber: true } },
            contact: { select: { name: true, phone: true } },
            department: { select: { name: true } },
            tags: { include: { tag: true } }
          }
        });
      }

      if (input.action === "change_priority") {
        conversation = await prisma.conversation.update({
          where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
          data: { priority: input.priority },
          include: {
            assignedUser: { select: { displayName: true } },
            channel: { select: { displayName: true, phoneNumber: true } },
            contact: { select: { name: true, phone: true } },
            department: { select: { name: true } },
            tags: { include: { tag: true } }
          }
        });
      }

      if (input.action === "change_primary_board_stage") {
        const stage = await prisma.contactBoardStage.findFirst({
          where: { workspaceId: input.workspaceId, id: input.stageId },
          include: { board: { select: { name: true } } }
        });

        if (!stage) {
          throw new ConversationActionError("BOARD_STAGE_NOT_FOUND", "Board stage not found.");
        }

        const updatedMembership = (await prisma.$transaction(async (tx) => {
          await tx.contactBoardMembership.updateMany({
            where: {
              workspaceId: input.workspaceId,
              contactId: conversation.contactId,
              isPrimary: true
            },
            data: { isPrimary: false }
          });

          return tx.contactBoardMembership.upsert({
            where: {
              workspaceId_contactId_boardId: {
                workspaceId: input.workspaceId,
                contactId: conversation.contactId,
                boardId: stage.boardId
              }
            },
            create: {
              workspaceId: input.workspaceId,
              contactId: conversation.contactId,
              boardId: stage.boardId,
              stageId: input.stageId,
              isPrimary: true
            },
            update: {
              stageId: input.stageId,
              isPrimary: true
            },
            include: {
              board: { select: { name: true } },
              stage: { select: { name: true, color: true } }
            }
          });
        })) as BoardMembershipRecord;
        boardMembership = toBoardMembershipDto(updatedMembership);
      }

      if (input.action === "add_tag") {
        const tagName = input.name.trim();
        const tag = await prisma.tag.upsert({
          where: {
            workspaceId_name: {
              workspaceId: input.workspaceId,
              name: tagName
            }
          },
          create: {
            workspaceId: input.workspaceId,
            name: tagName,
            color: "#24564a"
          },
          update: {}
        });

        await prisma.conversationTag.upsert({
          where: {
            workspaceId_conversationId_tagId: {
              workspaceId: input.workspaceId,
              conversationId: input.conversationId,
              tagId: tag.id
            }
          },
          create: {
            workspaceId: input.workspaceId,
            conversationId: input.conversationId,
            tagId: tag.id
          },
          update: {}
        });
        appliedTag = {
          conversationId: input.conversationId,
          tagId: tag.id
        };
      }

      if (input.action === "remove_tag") {
        await prisma.conversationTag.deleteMany({
          where: {
            workspaceId: input.workspaceId,
            conversationId: input.conversationId,
            tagId: input.tagId
          }
        });
      }

      if (input.action === "request_ai_suggestion") {
        aiSuggestion =
          "Sugestão: responda confirmando o pedido, recapitule o próximo passo e ofereça ajuda objetiva.";
        await prisma.aiActionLog.create({
          data: {
            workspaceId: input.workspaceId,
            conversationId: input.conversationId,
            contactId: conversation.contactId,
            userId: conversation.assignedUserId,
            actionType: "reply_suggestion",
            mode: "simulated",
            input: { lastMessagePreview: conversation.lastMessagePreview },
            result: { suggestion: aiSuggestion },
            status: "completed"
          }
        });
      }

      if (input.action === "create_crm_note") {
        const created = await prisma.crmSyncAction.create({
          data: {
            workspaceId: input.workspaceId,
            contactId: conversation.contactId,
            actionType: "create_note",
            mode: "simulated",
            status: "queued",
            payload: {
              conversationId: input.conversationId,
              note: conversation.lastMessagePreview ?? "Atendimento atualizado no Talk."
            },
            result: {
              provider: "vincula",
              simulated: true
            }
          }
        });
        crmAction = { id: created.id, status: created.status };
      }

      if (input.action === "close_conversation") {
        await stopProspectingConversation(prisma, input.workspaceId, input.conversationId, "conversation_closed");
        conversation = await prisma.conversation.update({
          where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
          data: {
            status: "closed",
            unreadCount: 0
          },
          include: {
            assignedUser: { select: { displayName: true } },
            channel: { select: { displayName: true, phoneNumber: true } },
            contact: { select: { name: true, phone: true } },
            department: { select: { name: true } },
            tags: { include: { tag: true } }
          }
        });
      }

      conversation = await findConversation(input);

      return {
        conversation: toConversationDto(conversation),
        context: await buildContactContext(conversation),
        ...(boardMembership ? { boardMembership } : {}),
        ...(appliedTag ? { appliedTag } : {}),
        ...(aiSuggestion ? { aiSuggestion } : {}),
        ...(crmAction ? { crmAction } : {})
      };
    },

    async resetConversation(input: {
      workspaceId: string;
      conversationId: string;
      actorUserId: string | null;
    }): Promise<ConversationActionResultDto> {
      const existing = await prisma.conversation.findUnique({
        where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
        select: { id: true, contactId: true }
      });

      if (!existing) {
        throw new ConversationNotFoundError();
      }

      await prisma.$transaction(async (tx) => {
        await stopProspectingConversation(tx, input.workspaceId, input.conversationId, "conversation_reset");
        await releaseEndedProspectingBinding(tx, input);
        await tx.conversation.update({
          where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
          data: {
            status: "open",
            assignedUserId: null,
            departmentId: null,
            lastMessageAt: null,
            lastMessagePreview: null,
            customerServiceWindowExpiresAt: null,
            unreadCount: 0,
            priority: "normal",
            aiControlStatus: "agent_allowed",
            aiControlUpdatedAt: new Date(),
            aiControlUpdatedById: input.actorUserId,
            activeAgentSessionId: null
          }
        });
        await tx.aiAgentPendingReply.deleteMany({
          where: { workspaceId: input.workspaceId, conversationId: input.conversationId }
        });
        await tx.aiAgentRun.deleteMany({
          where: { workspaceId: input.workspaceId, conversationId: input.conversationId }
        });
        await tx.aiActionLog.deleteMany({
          where: { workspaceId: input.workspaceId, conversationId: input.conversationId }
        });
        await tx.assistantConversationState?.deleteMany({ where: { workspaceId: input.workspaceId, conversationId: input.conversationId } });
        await tx.assistantSuggestion?.deleteMany({ where: { workspaceId: input.workspaceId, conversationId: input.conversationId } });
        await tx.conversationFollowup.deleteMany({
          where: { workspaceId: input.workspaceId, conversationId: input.conversationId }
        });
        await tx.message.deleteMany({
          where: { workspaceId: input.workspaceId, conversationId: input.conversationId }
        });
        await tx.conversationTag.deleteMany({
          where: { workspaceId: input.workspaceId, conversationId: input.conversationId }
        });
        await tx.contactNote.deleteMany({
          where: { workspaceId: input.workspaceId, contactId: existing.contactId }
        });
        await tx.aiAgentSession.deleteMany({
          where: { workspaceId: input.workspaceId, conversationId: input.conversationId }
        });
        await tx.auditLog.create({
          data: {
            workspaceId: input.workspaceId,
            actorUserId: input.actorUserId,
            action: "conversation.demo_reset",
            targetType: "conversation",
            targetId: input.conversationId,
            metadata: {}
          }
        });
      });

      const conversation = await findConversation(input);
      return {
        conversation: toConversationDto(conversation),
        context: await buildContactContext(conversation)
      };
    },

    async listMessages(input: {
      workspaceId: string;
      conversationId: string;
      compactMedia?: boolean;
    }): Promise<MessageDto[]> {
      const conversation = await prisma.conversation.findUnique({
        where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
        select: { id: true }
      });

      if (!conversation) {
        throw new ConversationNotFoundError();
      }

      // Conversations retired into this one keep their rows; their history reads here as one.
      const retired = prisma.conversation.findMany
        ? await prisma.conversation.findMany({ where: { workspaceId: input.workspaceId, retiredIntoConversationId: input.conversationId }, select: { id: true } })
        : [];
      const messages = await prisma.message.findMany({
        where: visibleConversationMessageWhere({
          workspaceId: input.workspaceId,
          conversationId: retired.length ? { in: [input.conversationId, ...retired.map(row => row.id)] } : input.conversationId
        }),
        // WhatsApp's own time, like WhatsApp: a message recovered after a disconnection sits where it was sent,
        // not at the bottom where it arrived.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100
      });

      const dtos = measureInboxAssembly(() => withoutInternalFollowupReservations([...messages]).reverse().map(record => input.compactMedia
        ? toCompactMessageDto(record, options.publicTalkUrl ?? 'https://talk.prymeiradigital.com.br') : toMessageDto(record)));
      // Messages written before the WhatsApp id was kept in their metadata get it from their canonical identity.
      const missing = dtos.filter(dto => !dto.whatsappId).map(dto => dto.id);
      if (missing.length && prisma.canonicalMessageIdentity?.findMany) {
        const identities = await prisma.canonicalMessageIdentity.findMany({ where: { workspaceId: input.workspaceId, messageId: { in: missing }, identityFormat: 'whatsapp_stanza' }, select: { messageId: true, rawId: true } });
        const byMessage = new Map(identities.map(row => [row.messageId, row.rawId]));
        for (const dto of dtos) if (!dto.whatsappId && byMessage.get(dto.id)) dto.whatsappId = byMessage.get(dto.id)!;
      }
      return dtos;
    }
  };
}
