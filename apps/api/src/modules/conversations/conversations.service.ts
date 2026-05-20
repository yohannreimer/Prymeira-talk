import type { PrismaClient } from "@prisma/client";
import type { ConversationDto, MessageDto } from "@prymeira-talk/shared";

type PrismaLike = Pick<PrismaClient, "conversation" | "message">;

type DateLike = Date | string;

interface ConversationRecord {
  id: string;
  workspaceId: string;
  channelId: string;
  contactId: string;
  status: ConversationDto["status"];
  assignedUserId: string | null;
  departmentId: string | null;
  lastMessageAt: DateLike | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  priority: ConversationDto["priority"];
}

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

function toIsoString(value: DateLike) {
  return value instanceof Date ? value.toISOString() : value;
}

export function toConversationDto(record: ConversationRecord): ConversationDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    channelId: record.channelId,
    contactId: record.contactId,
    status: record.status,
    assignedUserId: record.assignedUserId,
    departmentId: record.departmentId,
    lastMessageAt: record.lastMessageAt ? toIsoString(record.lastMessageAt) : null,
    lastMessagePreview: record.lastMessagePreview,
    unreadCount: record.unreadCount,
    priority: record.priority
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

export function createConversationsService(prisma: PrismaLike) {
  return {
    async listConversations(input: { workspaceId: string }): Promise<ConversationDto[]> {
      const conversations = await prisma.conversation.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
        take: 50
      });

      return conversations.map(toConversationDto);
    },

    async createPendingOutboundMessage(input: {
      workspaceId: string;
      conversationId: string;
      body: string;
      sentByUserId: string | null;
    }): Promise<MessageDto> {
      const message = await prisma.message.create({
        data: {
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          direction: "outbound",
          type: "text",
          body: input.body,
          status: "pending",
          sentByUserId: input.sentByUserId
        }
      });

      return toMessageDto(message);
    }
  };
}
