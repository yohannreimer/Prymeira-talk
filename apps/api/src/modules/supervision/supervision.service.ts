import type { Prisma, PrismaClient } from "@prisma/client";
import type { SupervisionConversation, SupervisionGrant, SupervisionPage, SupervisionSummary, SupervisionThread, SupervisionUnreadPeriod } from "@prymeira-talk/shared";
import { z } from "zod";
import { conversationDtoInclude, inboxHandoffWhere, inboxUnreadWhere, toConversationDto, toMessageDto } from "../conversations/conversations.service.js";
import { visibleConversationMessageWhere } from "../conversations/internal-message.js";
import { SupervisionError } from "./supervision-access.js";

type Store = Pick<PrismaClient, "conversation" | "message" | "channel">;
export type SupervisionFilters = {
  status?: "active" | "closed" | "all";
  sellerCustomerId?: string;
  nextAction?: boolean;
  unread?: boolean;
  unreadPeriod?: SupervisionUnreadPeriod;
  cursor?: string;
};
type Conversation = Prisma.ConversationGetPayload<{ include: typeof conversationDtoInclude }>;
const cursorSchema = z.object({
  workspaceId: z.string().uuid(), channelId: z.string().uuid(), id: z.string().uuid(),
  lastMessageAt: z.string().datetime().nullable(), createdAt: z.string().datetime()
}).strict();
const orderBy: Prisma.ConversationOrderByWithRelationInput[] = [
  { lastMessageAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }, { id: "desc" }
];

export function supervisionScopeWhere(grants: SupervisionGrant[]): Prisma.ConversationWhereInput {
  // OR pairs prevent a channel from one workspace granting access to another.
  // An empty set must never become an unrestricted query.
  if (!grants.length) throw new SupervisionError(403, "Nenhum vendedor autorizado para supervisão.");
  return { OR: grants.map(grant => ({ workspaceId: grant.workspace_id, channelId: grant.channel_id })) };
}

function filterGrants(grants: SupervisionGrant[], sellerCustomerId?: string) {
  const selected = sellerCustomerId ? grants.filter(grant => grant.seller_customer_id === sellerCustomerId) : grants;
  if (!selected.length) throw new SupervisionError(403, "Vendedor não autorizado para supervisão.");
  return selected;
}

export function supervisionListWhere(grants: SupervisionGrant[], filters: SupervisionFilters = {}, now = new Date()): Prisma.ConversationWhereInput {
  const hours = filters.unreadPeriod === "24h" ? 24 : filters.unreadPeriod === "7d" ? 168 : null;
  return { AND: [
    supervisionScopeWhere(filterGrants(grants, filters.sellerCustomerId)),
    { hiddenUntilReply: false },
    filters.status === "all" ? {} : filters.status === "closed" ? { status: "closed" } : { status: { in: ["open", "pending"] } },
    filters.nextAction ? inboxHandoffWhere : {},
    filters.unread ? inboxUnreadWhere : {},
    filters.unread && hours ? { messages: { some: visibleConversationMessageWhere({
      direction: "inbound" as const, createdAt: { gte: new Date(now.getTime() - hours * 3_600_000), lte: now }
    }) } } : {}
  ] };
}

function afterCursor(anchor: { id: string; lastMessageAt: Date | null; createdAt: Date }): Prisma.ConversationWhereInput {
  const createdAfter: Prisma.ConversationWhereInput = { OR: [
    { createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: anchor.id } }
  ] };
  if (!anchor.lastMessageAt) return { lastMessageAt: null, ...createdAfter };
  return { OR: [
    { lastMessageAt: { lt: anchor.lastMessageAt } },
    { lastMessageAt: anchor.lastMessageAt, ...createdAfter },
    { lastMessageAt: null }
  ] };
}

export function createSupervisionService(prisma: Store, clock: () => Date = () => new Date()) {
  function toDto(record: Conversation, grants: SupervisionGrant[]): SupervisionConversation {
    const grant = grants.find(item => item.workspace_id === record.workspaceId && item.channel_id === record.channelId);
    if (!grant) throw new SupervisionError(404, "Conversa não encontrada.");
    return { ...toConversationDto(record), sellerCustomerId: grant.seller_customer_id,
      sellerName: grant.seller_name, sellerEmail: grant.seller_email, channelPhoneNumber: record.channel.phoneNumber };
  }

  return {
    async summary(grants: SupervisionGrant[], unreadPeriod: SupervisionUnreadPeriod = "all"): Promise<SupervisionSummary> {
      supervisionScopeWhere(grants);
      const now = clock();
      const sellerIds = [...new Set(grants.map(grant => grant.seller_customer_id))];
      const sellers = await Promise.all(sellerIds.map(async sellerCustomerId => {
        const grant = grants.find(item => item.seller_customer_id === sellerCustomerId)!;
        const [nextActionCount, unreadConversationCount] = await Promise.all([
          prisma.conversation.count({ where: supervisionListWhere(grants, { sellerCustomerId, nextAction: true }) }),
          prisma.conversation.count({ where: supervisionListWhere(grants, { sellerCustomerId, unread: true, unreadPeriod }, now) })
        ]);
        return { sellerCustomerId, sellerName: grant.seller_name, sellerEmail: grant.seller_email,
          nextActionCount, unreadConversationCount };
      }));
      return { sellers: sellers.sort((a, b) => a.sellerName.localeCompare(b.sellerName, "pt-BR") || a.sellerCustomerId.localeCompare(b.sellerCustomerId)) };
    },

    async list(grants: SupervisionGrant[], filters: SupervisionFilters = {}): Promise<SupervisionPage> {
      const selected = filterGrants(grants, filters.sellerCustomerId);
      const where = supervisionListWhere(selected, filters, clock());
      let continuation: Prisma.ConversationWhereInput = {};
      if (filters.cursor) {
        let cursor: z.infer<typeof cursorSchema>;
        try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(filters.cursor, "base64url").toString("utf8"))); }
        catch { throw new SupervisionError(400, "Página inválida. Atualize a lista de conversas."); }
        if (!selected.some(grant => grant.workspace_id === cursor.workspaceId && grant.channel_id === cursor.channelId)) {
          throw new SupervisionError(400, "Página indisponível. Atualize a lista de conversas.");
        }
        // Snapshot the ordering boundary: messages arriving on the previous
        // page's last row must not move it and repeat already delivered rows.
        continuation = afterCursor({ id: cursor.id, createdAt: new Date(cursor.createdAt),
          lastMessageAt: cursor.lastMessageAt ? new Date(cursor.lastMessageAt) : null });
      }
      const rows = await prisma.conversation.findMany({
        where: { AND: [where, continuation] }, include: conversationDtoInclude, orderBy, take: 51
      });
      const page = rows.slice(0, 50);
      const last = page.at(-1);
      return { conversations: page.map(row => toDto(row, selected)),
        nextCursor: rows.length > 50 && last
          ? Buffer.from(JSON.stringify({ workspaceId: last.workspaceId, channelId: last.channelId, id: last.id,
            lastMessageAt: last.lastMessageAt?.toISOString() ?? null, createdAt: last.createdAt.toISOString() })).toString("base64url") : null };
    },

    async authorizedConversation(grants: SupervisionGrant[], workspaceId: string, conversationId: string) {
      const record = await prisma.conversation.findFirst({
        where: { AND: [supervisionScopeWhere(grants), { workspaceId, id: conversationId, hiddenUntilReply: false }] },
        include: conversationDtoInclude
      });
      if (!record) throw new SupervisionError(404, "Conversa não encontrada.");
      return toDto(record, grants);
    },

    async thread(grants: SupervisionGrant[], workspaceId: string, conversationId: string): Promise<SupervisionThread> {
      const conversation = await this.authorizedConversation(grants, workspaceId, conversationId);
      const messages = await prisma.message.findMany({
        where: visibleConversationMessageWhere({ workspaceId, conversationId }),
        orderBy: [{ createdAt: "asc" }, { id: "asc" }]
      });
      // Read only: no read receipt, history import, acknowledgement or AI work.
      return { conversation, messages: messages.map(toMessageDto) };
    },

    async channels(workspaceId: string) {
      const channels = await prisma.channel.findMany({ where: { workspaceId, archivedAt: null },
        select: { id: true, workspaceId: true, displayName: true, phoneNumber: true },
        orderBy: [{ displayName: "asc" }, { id: "asc" }] });
      return { channels: channels.map(channel => ({ ...channel,
        displayName: channel.displayName ?? channel.phoneNumber ?? "Canal sem nome" })) };
    }
  };
}
