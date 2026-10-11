import type { Prisma, PrismaClient } from "@prisma/client";
import type { SupervisionConversation, SupervisionGrant, SupervisionPage, SupervisionSummary, SupervisionThread, SupervisionUnreadPeriod } from "@prymeira-talk/shared";
import { z } from "zod";
import { conversationDtoInclude, inboxHandoffWhere, inboxUnreadWhere, toConversationDto, toMessageDto } from "../conversations/conversations.service.js";
import { visibleConversationMessageWhere } from "../conversations/internal-message.js";
import { SupervisionError } from "./supervision-access.js";
import { nextActionText, todayActivity, waitingConversations } from "./supervision-insights.js";

type Store = Pick<PrismaClient, "conversation" | "message" | "channel"> & Partial<Pick<PrismaClient, "$queryRaw">>;
export type SupervisionFilters = {
  status?: "active" | "closed" | "all";
  sellerCustomerId?: string;
  nextAction?: boolean;
  unread?: boolean;
  unreadPeriod?: SupervisionUnreadPeriod;
  /** Only customers waiting for an answer, the longest wait first. */
  waiting?: boolean;
  /** Customer name or phone digits. */
  search?: string;
  cursor?: string;
};
/** The inbox include plus the session metadata, where the handoff brief keeps the seller's next action. */
const supervisionInclude = { ...conversationDtoInclude, activeAgentSession: { select: { ...conversationDtoInclude.activeAgentSession.select, metadata: true } } } as const;
type Conversation = Prisma.ConversationGetPayload<{ include: typeof supervisionInclude }>;
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
    { hiddenUntilReply: false, retiredIntoConversationId: null },
    filters.status === "all" ? {} : filters.status === "closed" ? { status: "closed" } : { status: { in: ["open", "pending"] } },
    filters.nextAction ? inboxHandoffWhere : {},
    filters.unread ? inboxUnreadWhere : {},
    filters.search?.trim() ? searchWhere(filters.search.trim()) : {},
    filters.unread && hours ? { messages: { some: visibleConversationMessageWhere({
      direction: "inbound" as const, createdAt: { gte: new Date(now.getTime() - hours * 3_600_000), lte: now }
    }) } } : {}
  ] };
}

function searchWhere(search: string): Prisma.ConversationWhereInput {
  const digits = search.replace(/\D/g, "");
  return { contact: { OR: [{ name: { contains: search, mode: "insensitive" } }, ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : [])] } };
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
      sellerName: grant.seller_name, sellerEmail: grant.seller_email, channelPhoneNumber: record.channel.phoneNumber,
      nextActionText: nextActionText(record.activeAgentSession) };
  }
  /** Adds how long each customer of the page has been waiting; a failure leaves the page as it was. */
  async function withWaiting(conversations: SupervisionConversation[], grants: SupervisionGrant[]) {
    if (!conversations.length || typeof prisma.$queryRaw !== "function") return conversations;
    try {
      const rows = await waitingConversations(prisma as Required<Store>, grants, clock(), conversations.map(conversation => conversation.id));
      const since = new Map(rows.map(row => [`${row.workspace_id}:${row.conversation_id}`, row.waiting_since.toISOString()]));
      return conversations.map(conversation => ({ ...conversation, waitingSince: since.get(`${conversation.workspaceId}:${conversation.id}`) ?? null }));
    } catch { return conversations; }
  }

  return {
    async summary(grants: SupervisionGrant[], unreadPeriod: SupervisionUnreadPeriod = "all"): Promise<SupervisionSummary> {
      supervisionScopeWhere(grants);
      const now = clock();
      const sellerIds = [...new Set(grants.map(grant => grant.seller_customer_id))];
      // The team's pulse: who is waiting and today's work. Optional, so the counts below never depend on it.
      const [waiting, today] = typeof prisma.$queryRaw === "function" ? await Promise.all([
        waitingConversations(prisma as Required<Store>, grants, now).catch(() => null),
        todayActivity(prisma as Required<Store>, grants, now).catch(() => null)
      ]) : [null, null];
      const sellers = await Promise.all(sellerIds.map(async sellerCustomerId => {
        const grant = grants.find(item => item.seller_customer_id === sellerCustomerId)!;
        const [nextActionCount, unreadConversationCount] = await Promise.all([
          prisma.conversation.count({ where: supervisionListWhere(grants, { sellerCustomerId, nextAction: true }) }),
          prisma.conversation.count({ where: supervisionListWhere(grants, { sellerCustomerId, unread: true, unreadPeriod }, now) })
        ]);
        const mine = waiting?.filter(row => row.seller_id === sellerCustomerId);
        const activity = today?.find(row => row.seller_id === sellerCustomerId);
        return { sellerCustomerId, sellerName: grant.seller_name, sellerEmail: grant.seller_email,
          nextActionCount, unreadConversationCount,
          ...(mine ? { waitingCount: mine.length, oldestWaitingSince: mine[0]?.waiting_since.toISOString() ?? null } : {}),
          ...(today ? { today: { received: activity?.received ?? 0, sent: activity?.sent ?? 0, conversations: activity?.conversations ?? 0,
            medianResponseSeconds: activity?.median_response_seconds ?? null } } : {}) };
      }));
      return { sellers: sellers.sort((a, b) => a.sellerName.localeCompare(b.sellerName, "pt-BR") || a.sellerCustomerId.localeCompare(b.sellerCustomerId)) };
    },

    async list(grants: SupervisionGrant[], filters: SupervisionFilters = {}): Promise<SupervisionPage> {
      const selected = filterGrants(grants, filters.sellerCustomerId);
      if (filters.waiting && !filters.search?.trim()) {
        // The attention queue: every waiting customer, the longest wait first (bounded, so no cursor).
        if (typeof prisma.$queryRaw !== "function") return { conversations: [], nextCursor: null };
        const rows = await waitingConversations(prisma as Required<Store>, selected, clock());
        if (!rows.length) return { conversations: [], nextCursor: null };
        const records = await prisma.conversation.findMany({
          where: { AND: [supervisionScopeWhere(selected), { id: { in: rows.map(row => row.conversation_id) } }] }, include: supervisionInclude
        });
        const byKey = new Map(records.map(record => [`${record.workspaceId}:${record.id}`, record]));
        return { conversations: rows.flatMap(row => {
          const record = byKey.get(`${row.workspace_id}:${row.conversation_id}`);
          return record ? [{ ...toDto(record, selected), waitingSince: row.waiting_since.toISOString() }] : [];
        }), nextCursor: null };
      }
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
        where: { AND: [where, continuation] }, include: supervisionInclude, orderBy, take: 51
      });
      const page = rows.slice(0, 50);
      const last = page.at(-1);
      return { conversations: await withWaiting(page.map(row => toDto(row, selected)), selected),
        nextCursor: rows.length > 50 && last
          ? Buffer.from(JSON.stringify({ workspaceId: last.workspaceId, channelId: last.channelId, id: last.id,
            lastMessageAt: last.lastMessageAt?.toISOString() ?? null, createdAt: last.createdAt.toISOString() })).toString("base64url") : null };
    },

    async authorizedConversation(grants: SupervisionGrant[], workspaceId: string, conversationId: string) {
      const record = await prisma.conversation.findFirst({
        where: { AND: [supervisionScopeWhere(grants), { workspaceId, id: conversationId, hiddenUntilReply: false }] },
        include: supervisionInclude
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
      return { conversation: (await withWaiting([conversation], grants))[0]!, messages: messages.map(toMessageDto) };
    },

    /** "Não precisa responder": the customer's messages so far stop counting as waiting (a greeting, an automatic
     * welcome); their next message waits again. Undo clears the mark. Nothing is sent and the seller's inbox is untouched. */
    async setWaitingDismissed(grants: SupervisionGrant[], workspaceId: string, conversationId: string, dismissed: boolean) {
      await this.authorizedConversation(grants, workspaceId, conversationId);
      // Up to the latest customer message, not "now": a message arriving after the click still waits.
      const latest = dismissed ? await prisma.message.findFirst({ where: { workspaceId, conversationId, direction: "inbound" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { createdAt: true } }) : null;
      await prisma.conversation.update({ where: { workspaceId_id: { workspaceId, id: conversationId } },
        data: { waitingDismissedAt: dismissed ? latest?.createdAt ?? clock() : null } });
      return { dismissed };
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
