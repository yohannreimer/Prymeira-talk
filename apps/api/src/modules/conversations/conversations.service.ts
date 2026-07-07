import type { ConversationStatus, PrismaClient } from "@prisma/client";
import type { ContactBoardMembershipDto, ConversationDto, MessageDto } from "@prymeira-talk/shared";
import type { EvolutionRuntime } from "../evolution/evolution-runtime.js";
import type { MetaClient } from "../meta/meta.client.js";

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
  | "BOARD_STAGE_NOT_FOUND";

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
  | "OUTBOUND_CONTACT_PHONE_REQUIRED"
  | "OUTBOUND_PROVIDER_KEY_REQUIRED"
  | "META_MEDIA_NOT_SUPPORTED"
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

export interface ConversationRecord {
  id: string;
  workspaceId: string;
  channelId: string;
  contactId: string;
  contact?: {
    name?: string | null;
    phone?: string | null;
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
  lastMessagePreview: string | null;
  unreadCount: number;
  priority: ConversationDto["priority"];
  aiControlStatus?: NonNullable<ConversationDto["aiControlStatus"]>;
  activeAgentSessionId?: string | null;
  activeAgentSession?: {
    status: NonNullable<ConversationDto["activeAgentSessionStatus"]>;
    handoffReason?: string | null;
    agent?: {
      name: string;
    } | null;
  } | null;
  tags?: Array<{
    tag: TagRecord;
  }>;
}

const conversationDtoInclude = {
  assignedUser: { select: { displayName: true } },
  channel: { select: { displayName: true, phoneNumber: true, provider: true } },
  contact: { select: { name: true, phone: true } },
  department: { select: { name: true } },
  activeAgentSession: {
    select: {
      status: true,
      handoffReason: true,
      agent: { select: { name: true } }
    }
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
type ContactNoteCreateArgs = Parameters<PrismaClient["contactNote"]["create"]>[0];
type ContactNoteFindManyArgs = Parameters<PrismaClient["contactNote"]["findMany"]>[0];
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
type AiActionLogCreateArgs = Parameters<PrismaClient["aiActionLog"]["create"]>[0];
type CrmSyncActionCreateArgs = Parameters<PrismaClient["crmSyncAction"]["create"]>[0];

export interface PrismaLike {
  conversation: {
    findMany(args: ConversationFindManyArgs): Promise<ConversationRecord[]>;
    findUnique(args: ConversationFindUniqueArgs): Promise<(Partial<ConversationRecord> & { id: string }) | null>;
    update(args: ConversationUpdateArgs): Promise<ConversationRecord>;
  };
  message: {
    create(args: MessageCreateArgs): Promise<MessageRecord>;
    findMany(args: MessageFindManyArgs): Promise<MessageRecord[]>;
  };
  contactNote: {
    create(args: ContactNoteCreateArgs): Promise<ContactNoteRecord>;
    findMany(args: ContactNoteFindManyArgs): Promise<ContactNoteRecord[]>;
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
  };
  aiActionLog: {
    create(args: AiActionLogCreateArgs): Promise<{ id: string; status: string }>;
  };
  crmSyncAction: {
    create(args: CrmSyncActionCreateArgs): Promise<{ id: string; status: string }>;
  };
  $transaction(callback: (tx: PrismaLike) => Promise<unknown>): Promise<unknown>;
}

interface ConversationsServiceOptions {
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

function toIsoString(value: DateLike) {
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

export function toConversationDto(record: ConversationRecord): ConversationDto {
  const channelProvider = toChannelProvider(record.channel?.provider);
  const customerServiceWindowExpiresAt = record.customerServiceWindowExpiresAt
    ? toIsoString(record.customerServiceWindowExpiresAt)
    : null;

  return {
    id: record.id,
    workspaceId: record.workspaceId,
    channelId: record.channelId,
    contactId: record.contactId,
    contactName: record.contact?.name ?? null,
    contactPhone: record.contact?.phone ?? null,
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
    lastMessagePreview: record.lastMessagePreview,
    unreadCount: record.unreadCount,
    priority: record.priority,
    aiControlStatus: record.aiControlStatus ?? "agent_allowed",
    activeAgentName: record.activeAgentSession?.agent?.name ?? null,
    activeAgentSessionStatus: record.activeAgentSession?.status ?? null,
    handoffReason: record.activeAgentSession?.handoffReason ?? null
  };
}

export function toMessageDto(record: MessageRecord): MessageDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    conversationId: record.conversationId,
    providerMessageId: record.providerMessageId ?? null,
    direction: record.direction,
    type: record.type,
    body: record.body,
    mediaUrl: record.mediaUrl ?? null,
    status: record.status,
    sentByUserId: record.sentByUserId ?? null,
    createdAt: toIsoString(record.createdAt)
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

  function conversationListWhere(input: { workspaceId: string; status?: ConversationListStatus }) {
    if (input.status === "closed") {
      return {
        workspaceId: input.workspaceId,
        status: "closed" as const
      };
    }

    if (input.status === "all") {
      return {
        workspaceId: input.workspaceId
      };
    }

    return {
      workspaceId: input.workspaceId,
      status: { in: activeConversationStatuses }
    };
  }

  async function findConversation(input: {
    workspaceId: string;
    conversationId: string;
  }): Promise<ConversationRecord> {
    const conversation = await prisma.conversation.findUnique({
      where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
      include: {
        assignedUser: { select: { displayName: true } },
        channel: { select: { displayName: true, phoneNumber: true, provider: true } },
        contact: { select: { name: true, phone: true } },
        department: { select: { name: true } },
        activeAgentSession: {
          select: {
            status: true,
            handoffReason: true,
            agent: { select: { name: true } }
          }
        },
        tags: { include: { tag: true } }
      }
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

    return {
      primaryBoardStage: toPrimaryBoardStageDto(primaryMembership),
      tags: conversation.tags?.map((tagLink) => tagLink.tag) ?? [],
      notes: notes.map(toNoteDto),
      departments: departments.map((department) => ({
        id: department.id,
        name: department.name
      })),
      boardStages: boardStages.map(toBoardStageOptionDto)
    };
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
    async listConversations(input: {
      workspaceId: string;
      status?: ConversationListStatus;
    }): Promise<ConversationDto[]> {
      const conversations = await prisma.conversation.findMany({
        where: conversationListWhere(input),
        include: conversationDtoInclude,
        orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
        take: 50
      });

      return conversations.map(toConversationDto);
    },

    async createPendingOutboundMessage(input: {
      workspaceId: string;
      conversationId: string;
      body?: string;
      attachment?: {
        fileName: string;
        mimetype: string;
        mediaUrl: string;
      };
      sentByUserId: string | null;
    }): Promise<{ message: MessageDto; conversation: ConversationDto }> {
      const conversation = await prisma.conversation.findUnique({
        where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
        select: {
          customerServiceWindowExpiresAt: true,
          id: true,
          channel: { select: { provider: true, providerKey: true } },
          contact: { select: { phone: true } }
        }
      });

      if (!conversation) {
        throw new ConversationNotFoundError();
      }

      const messageBody = input.body?.trim() || input.attachment?.fileName || "";
      const messageType: MessageDto["type"] = input.attachment
        ? input.attachment.mimetype.toLowerCase().startsWith("image/")
          ? "image"
          : "file"
        : "text";

      let providerSend: { providerMessageId: string | null; raw: unknown } | null = null;

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

        providerSend = input.attachment
          ? await options.evolution.client.sendMedia({
              instanceName: providerKey,
              number: contactPhone,
              mediatype: messageType === "image" ? "image" : "document",
              mimetype: input.attachment.mimetype,
              media: input.attachment.mediaUrl,
              fileName: input.attachment.fileName,
              caption: input.body
            })
          : await options.evolution.client.sendText({
              instanceName: providerKey,
              number: contactPhone,
              text: messageBody
            });
      }

      if (conversation.channel?.provider === "meta_cloud") {
        const contactPhone = conversation.contact?.phone?.trim();
        const providerKey = conversation.channel.providerKey?.trim();
        const phoneNumberId = options.meta?.phoneNumberId?.trim();
        const metaClient = options.meta?.client;
        const metaEvolutionClient = options.metaEvolution?.client;

        if (input.attachment) {
          throw new OutboundMessageValidationError(
            "META_MEDIA_NOT_SUPPORTED",
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

          providerSend = await metaEvolutionClient.sendText({
            instanceName: providerKey,
            number: contactPhone,
            text: messageBody
          });
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

          providerSend = await metaClient.sendText({
            phoneNumberId,
            to: contactPhone,
            text: messageBody
          });
        }
      }

      const message = await prisma.message.create({
        data: {
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          direction: "outbound",
          type: messageType,
          body: messageBody,
          mediaUrl: input.attachment?.mediaUrl,
          providerMessageId: providerSend?.providerMessageId ?? undefined,
          status: providerSend ? "sent" : "pending",
          sentByUserId: input.sentByUserId
        }
      });

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
        ...(aiSuggestion ? { aiSuggestion } : {}),
        ...(crmAction ? { crmAction } : {})
      };
    },

    async listMessages(input: {
      workspaceId: string;
      conversationId: string;
    }): Promise<MessageDto[]> {
      const conversation = await prisma.conversation.findUnique({
        where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
        select: { id: true }
      });

      if (!conversation) {
        throw new ConversationNotFoundError();
      }

      const messages = await prisma.message.findMany({
        where: {
          workspaceId: input.workspaceId,
          conversationId: input.conversationId
        },
        orderBy: { createdAt: "asc" },
        take: 100
      });

      return messages.map(toMessageDto);
    }
  };
}
