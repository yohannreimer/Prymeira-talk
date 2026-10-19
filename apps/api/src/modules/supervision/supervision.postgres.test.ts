import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { needsHumanAttention, supervisionPageSchema, supervisionSummarySchema, supervisionThreadSchema, type SupervisionGrant } from "@prymeira-talk/shared";
import { authContextPlugin } from "../../plugins/auth-context.js";
import { createConversationsService, type PrismaLike } from "../conversations/conversations.service.js";
import { supervisionRoutes } from "./supervision.routes.js";
import { createSupervisionService } from "./supervision.service.js";

const databaseUrl = process.env.SUPERVISION_TEST_DATABASE_URL;
const workspaceIds = [randomUUID(), randomUUID()];
const sellerIds = [randomUUID(), randomUUID()];
const channelIds = [randomUUID(), randomUUID(), randomUUID()];
const supervisorId = randomUUID();
const grants: SupervisionGrant[] = sellerIds.map((sellerId, index) => ({ id: randomUUID(), supervisor_customer_id: supervisorId,
  seller_customer_id: sellerId, seller_name: `Vendedor ${index + 1}`, seller_email: `vendedor${index + 1}@example.test`,
  workspace_id: workspaceIds[index], channel_id: channelIds[index] }));

describe.skipIf(!databaseUrl)("supervision on PostgreSQL", () => {
  let prisma: PrismaClient;
  let service: ReturnType<typeof createSupervisionService>;
  let firstConversationId: string;
  let firstSessionId: string;
  let otherChannelConversationId: string;
  let attachmentId: string;
  let app: ReturnType<typeof Fastify>;
  let authorized: SupervisionGrant[];

  beforeAll(async () => {
    if (!new URL(databaseUrl!).pathname.endsWith("_test")) throw new Error("Integration tests require a disposable *_test database.");
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    service = createSupervisionService(prisma);
    const agents = await Promise.all(workspaceIds.map(workspaceId => prisma.aiAgent.create({ data: { workspaceId, name: "Qualificação", systemPrompt: "Teste" } })));
    await prisma.channel.createMany({ data: channelIds.map((id, index) => ({ id,
      workspaceId: index === 1 ? workspaceIds[1] : workspaceIds[0], provider: "evolution", providerKey: `test-${id}`,
      displayName: `WhatsApp ${index + 1}`, phoneNumber: `551199999000${index}` })) });
    for (const [seller, count] of [[0, 60], [1, 8], [2, 4]] as const) {
      const workspaceIndex = seller === 1 ? 1 : 0;
      for (let i = 0; i < count; i++) {
        const workspaceId = workspaceIds[workspaceIndex];
        const contact = await prisma.contact.create({ data: { workspaceId, phone: `55118888${seller}${String(i).padStart(3, "0")}`, name: `Cliente ${seller}-${i}` } });
        const createdAt = new Date(Date.UTC(2026, 8, 29, 10, 0, i));
        const record = await prisma.conversation.create({ data: { workspaceId, channelId: channelIds[seller], contactId: contact.id,
          unreadCount: seller === 1 && i % 2 ? 0 : 2, status: i === 1 ? "pending" : "open",
          aiControlStatus: seller === 1 && i >= 4 ? "agent_allowed" : "human_controlled",
          lastMessageAt: i < 3 ? null : createdAt, createdAt, lastMessagePreview: "Preciso de uma cotação" } });
        const session = await prisma.aiAgentSession.create({ data: { workspaceId, agentId: agents[workspaceIndex].id,
          conversationId: record.id, status: seller === 1 && i >= 4 ? "active" : "handoff_requested",
          handoffReason: seller === 1 && i >= 4 ? null : "Qualificação concluída" } });
        await prisma.conversation.update({ where: { id: record.id }, data: { activeAgentSessionId: session.id } });
        if (seller === 0 && i === 0) { firstConversationId = record.id; firstSessionId = session.id; }
        if (seller === 2 && i === 0) otherChannelConversationId = record.id;
      }
    }
    // These rows must not contribute to active indicators.
    const hiddenContact = await prisma.contact.create({ data: { workspaceId: workspaceIds[0], phone: "5511000000001" } });
    await prisma.conversation.create({ data: { workspaceId: workspaceIds[0], channelId: channelIds[0], contactId: hiddenContact.id, hiddenUntilReply: true, unreadCount: 9 } });
    const closedContact = await prisma.contact.create({ data: { workspaceId: workspaceIds[0], phone: "5511000000002" } });
    await prisma.conversation.create({ data: { workspaceId: workspaceIds[0], channelId: channelIds[0], contactId: closedContact.id, status: "closed", unreadCount: 9 } });
    const attachment = await prisma.message.create({ data: { workspaceId: workspaceIds[0], conversationId: firstConversationId,
      direction: "inbound", type: "image", status: "delivered", body: "Imagem recebida",
      mediaUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ3kAAAAASUVORK5CYII=" } });
    attachmentId = attachment.id;
    await prisma.message.create({ data: { workspaceId: workspaceIds[0], conversationId: firstConversationId,
      direction: "outbound", type: "text", body: "Reserva interna", metadata: { source: "followup_review", followupId: randomUUID() } } });
    authorized = grants;
    app = Fastify();
    app.decorate("prisma", prisma);
    await app.register(authContextPlugin, { accountApiUrl: "http://hub.test", productKey: "talk",
      fetch: vi.fn().mockImplementation(async () => new Response(JSON.stringify({ grants: authorized }))) });
    await app.register(supervisionRoutes);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    if (!prisma) return;
    await prisma.conversation.updateMany({ where: { workspaceId: { in: workspaceIds } }, data: { activeAgentSessionId: null } });
    await prisma.aiAgentSession.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.conversation.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.channel.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.contact.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.aiAgent.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.$disconnect();
  });

  it("counts the whole authorized queue beyond 50 and combines seller/next-action/unread filters", async () => {
    const summary = supervisionSummarySchema.parse(await service.summary(grants));
    expect(summary.sellers.map(item => [item.nextActionCount, item.unreadConversationCount])).toEqual([[60, 60], [4, 2]]);
    const page = supervisionPageSchema.parse(await service.list(grants, { nextAction: true }));
    expect(page.conversations).toHaveLength(50);
    expect(page.nextCursor).not.toBeNull();
    const filtered = await service.list(grants, { sellerCustomerId: sellerIds[1], nextAction: true, unread: true });
    expect(filtered.conversations).toHaveLength(2);
    expect(filtered.conversations.every(item => item.sellerCustomerId === sellerIds[1] && item.unreadCount > 0 && needsHumanAttention(item))).toBe(true);
    const sellerQueue = await createConversationsService(prisma as unknown as PrismaLike)
      .listConversations({ workspaceId: workspaceIds[1], channelId: channelIds[1], view: "unread" });
    const supervisorQueue = await service.list(grants, { sellerCustomerId: sellerIds[1], unread: true });
    expect(supervisorQueue.conversations.map(item => item.id)).toEqual(sellerQueue.map(item => item.id));
    expect((await service.list(grants, { status: "closed" })).conversations).toHaveLength(1);
    expect((await service.list(grants, { status: "closed", nextAction: true })).conversations).toHaveLength(0);
    await expect(service.list(grants, { sellerCustomerId: randomUUID() })).rejects.toMatchObject({ statusCode: 403 });
  });

  it("paginates across sellers with tied timestamps and null activity without duplicates", async () => {
    const first = await service.list(grants, { nextAction: true });
    const second = await service.list(grants, { nextAction: true, cursor: first.nextCursor! });
    expect(second.conversations).toHaveLength(14);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.conversations, ...second.conversations].map(item => item.id)).size).toBe(64);
    expect(second.conversations.slice(-6).every(item => item.lastMessageAt === null)).toBe(true);
    const foreignCursor = Buffer.from(JSON.stringify({ workspaceId: workspaceIds[0], id: otherChannelConversationId })).toString("base64url");
    await expect(service.list(grants, { cursor: foreignCursor })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.list(grants, { cursor: "not-a-cursor" })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("filters unread periods by inbound message time across the full queue without ageing next actions or seller history", async () => {
    const now = new Date();
    const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
    const periodService = createSupervisionService(prisma, () => now);
    const channelId = randomUUID();
    await prisma.channel.create({ data: { id: channelId, workspaceId: workspaceIds[0], provider: "evolution", providerKey: `period-${channelId}` } });
    const periodGrants = [{ ...grants[0], id: randomUUID(), channel_id: channelId }];
    const agent = await prisma.aiAgent.findFirstOrThrow({ where: { workspaceId: workspaceIds[0] } });
    let oldConversationId = "";
    for (let index = 0; index < 63; index++) {
      const unreadCount = index === 59 ? 0 : 2;
      const inboundAt = index === 0 ? hoursAgo(24) : index === 55 ? hoursAgo(25)
        : index === 56 ? hoursAgo(6 * 24) : index === 57 ? hoursAgo(8 * 24)
        : index === 58 ? hoursAgo(21 * 24) : hoursAgo(12);
      const contact = await prisma.contact.create({ data: { workspaceId: workspaceIds[0], phone: `period-${channelId}-${index}` } });
      const conversation = await prisma.conversation.create({ data: {
        workspaceId: workspaceIds[0], channelId, contactId: contact.id, unreadCount,
        status: index === 62 ? "closed" : "open", hiddenUntilReply: index === 61,
        aiControlStatus: index === 60 ? "agent_allowed" : "human_controlled", lastMessageAt: inboundAt
      } });
      const session = await prisma.aiAgentSession.create({ data: {
        workspaceId: workspaceIds[0], conversationId: conversation.id, agentId: agent.id,
        status: index === 60 ? "active" : "handoff_requested", handoffReason: index === 60 ? null : "Qualificação concluída"
      } });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { activeAgentSessionId: session.id } });
      await prisma.message.create({ data: { workspaceId: workspaceIds[0], conversationId: conversation.id,
        direction: "inbound", type: "text", body: "Mensagem do cliente", status: "delivered", createdAt: inboundAt } });
      if (index === 58) oldConversationId = conversation.id;
    }
    // Neither recent outbound activity nor a future timestamp makes an old unread conversation recent.
    await prisma.message.createMany({ data: [
      { workspaceId: workspaceIds[0], conversationId: oldConversationId, direction: "outbound", type: "text", body: "Resposta recente", status: "delivered", createdAt: now },
      { workspaceId: workspaceIds[0], conversationId: oldConversationId, direction: "inbound", type: "text", body: "Data futura", status: "delivered", createdAt: hoursAgo(-1) }
    ] });
    await prisma.conversation.update({ where: { id: oldConversationId }, data: { lastMessageAt: now } });
    expect((await periodService.summary(periodGrants, "24h")).sellers[0]).toMatchObject({ nextActionCount: 60, unreadConversationCount: 55 });
    expect((await periodService.summary(periodGrants, "7d")).sellers[0]).toMatchObject({ nextActionCount: 60, unreadConversationCount: 57 });
    expect((await periodService.summary(periodGrants, "all")).sellers[0].unreadConversationCount).toBe(59);
    const filters = { sellerCustomerId: sellerIds[0], nextAction: true, unread: true, unreadPeriod: "24h" as const };
    const first = await periodService.list(periodGrants, filters);
    const second = await periodService.list(periodGrants, { ...filters, cursor: first.nextCursor! });
    expect(first.conversations).toHaveLength(50); expect(second.conversations).toHaveLength(5);
    expect(new Set([...first.conversations, ...second.conversations].map(item => item.id)).size).toBe(55);
    expect(first.conversations.some(item => item.id === oldConversationId)).toBe(false);
    // Period is independent from the full seller history and next action filters.
    const allFilters = { sellerCustomerId: sellerIds[0], status: "all" as const, unread: false, unreadPeriod: "24h" as const };
    const allFirst = await periodService.list(periodGrants, allFilters);
    const allSecond = await periodService.list(periodGrants, { ...allFilters, cursor: allFirst.nextCursor! });
    expect(allFirst.conversations.length + allSecond.conversations.length).toBe(62);
    expect(allFirst.conversations.some(item => item.id === oldConversationId)).toBe(true);
    const before = await prisma.conversation.findUniqueOrThrow({ where: { id: oldConversationId } });
    await periodService.thread(periodGrants, workspaceIds[0], oldConversationId);
    expect(await prisma.conversation.findUnique({ where: { id: oldConversationId } })).toEqual(before);
    const newInbound = await prisma.message.create({ data: { workspaceId: workspaceIds[0], conversationId: oldConversationId,
      direction: "inbound", type: "text", body: "Cliente retomou a conversa", status: "delivered", createdAt: now } });
    expect((await periodService.summary(periodGrants, "24h")).sellers[0].unreadConversationCount).toBe(56);
    await prisma.message.delete({ where: { id: newInbound.id } });
    const headers = { authorization: "Bearer supervisor" };
    authorized = periodGrants;
    try {
      const summaryResponse = await app.inject({ url: "/supervision/summary?unreadPeriod=7d", headers });
      expect(summaryResponse.statusCode).toBe(200);
      expect(summaryResponse.json().sellers[0]).toMatchObject({ nextActionCount: 60, unreadConversationCount: 57 });
      const query = new URLSearchParams({ sellerCustomerId: sellerIds[0], unread: "true", nextAction: "true", unreadPeriod: "7d" });
      const pageResponse = await app.inject({ url: `/supervision/conversations?${query}`, headers });
      expect(pageResponse.statusCode).toBe(200);
      const page = supervisionPageSchema.parse(pageResponse.json());
      expect(page.conversations).toHaveLength(50);
      query.set("cursor", page.nextCursor!);
      const next = await app.inject({ url: `/supervision/conversations?${query}`, headers });
      expect(supervisionPageSchema.parse(next.json()).conversations).toHaveLength(7);
    } finally { authorized = grants; }
    expect((await app.inject({ url: "/supervision/summary?unreadPeriod=invalid", headers })).statusCode).toBe(400);
    expect((await app.inject({ url: "/supervision/conversations?unread=true&unreadPeriod=invalid", headers })).statusCode).toBe(400);
    await expect(periodService.list(periodGrants, { ...filters, sellerCustomerId: sellerIds[1] })).rejects.toMatchObject({ statusCode: 403 });
  }, 30_000);

  it("reading preserves seller unread and handoff states; seller read and completion change the same supervisor queue", async () => {
    const before = await prisma.conversation.findUniqueOrThrow({ where: { id: firstConversationId } });
    const sessionBefore = await prisma.aiAgentSession.findUniqueOrThrow({ where: { id: firstSessionId } });
    const thread = supervisionThreadSchema.parse(await service.thread(grants, workspaceIds[0], firstConversationId));
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0].id).toBe(attachmentId);
    expect(needsHumanAttention(thread.conversation)).toBe(true);
    expect(await prisma.conversation.findUnique({ where: { id: firstConversationId } })).toEqual(before);
    expect(await prisma.aiAgentSession.findUnique({ where: { id: firstSessionId } })).toEqual(sessionBefore);
    const sellerService = createConversationsService(prisma as unknown as PrismaLike);
    try {
      await sellerService.markConversationRead({ workspaceId: workspaceIds[0], conversationId: firstConversationId });
      let summary = await service.summary(grants);
      expect(summary.sellers[0]).toMatchObject({ nextActionCount: 60, unreadConversationCount: 59 });
      const completed = await sellerService.updateHandoffAction({ workspaceId: workspaceIds[0], conversationId: firstConversationId, completed: true });
      expect(needsHumanAttention(completed)).toBe(false);
      summary = await service.summary(grants);
      expect(summary.sellers[0].nextActionCount).toBe(59);
      expect((await service.list(grants, { nextAction: true, sellerCustomerId: sellerIds[0] })).conversations.some(item => item.id === firstConversationId)).toBe(false);
    } finally {
      await prisma.conversation.update({ where: { id: firstConversationId }, data: { unreadCount: before.unreadCount } });
      await prisma.aiAgentSession.update({ where: { id: firstSessionId }, data: { handoffActionCompletedAt: null } });
    }
  });

  it("keeps continuation stable when the previous page's anchor receives a new message", async () => {
    const first = await service.list(grants, { nextAction: true });
    const anchor = first.conversations.at(-1)!;
    const before = await prisma.conversation.findUniqueOrThrow({ where: { id: anchor.id } });
    try {
      await prisma.conversation.update({ where: { id: anchor.id }, data: { lastMessageAt: new Date("2026-09-30T12:00:00Z") } });
      const second = await service.list(grants, { nextAction: true, cursor: first.nextCursor! });
      expect(second.conversations).toHaveLength(14);
      const firstIds = new Set(first.conversations.map(item => item.id));
      expect(second.conversations.some(item => firstIds.has(item.id))).toBe(false);
      expect(new Set([...first.conversations, ...second.conversations].map(item => item.id)).size).toBe(64);
    } finally { await prisma.conversation.update({ where: { id: anchor.id }, data: { lastMessageAt: before.lastMessageAt } }); }
  });

  it("blocks foreign channel histories, forged workspace pairs, and cached attachments after revocation", async () => {
    const headers = { authorization: "Bearer supervisor" };
    const base = `/supervision/workspaces/${workspaceIds[0]}/conversations/${firstConversationId}`;
    const mediaUrl = `${base}/messages/${attachmentId}/media`;
    let response = await app.inject({ url: mediaUrl, headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/png");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect((await app.inject({ url: `/supervision/workspaces/${workspaceIds[0]}/conversations/${otherChannelConversationId}/messages`, headers })).statusCode).toBe(404);
    expect((await app.inject({ url: `/supervision/workspaces/${workspaceIds[1]}/conversations/${firstConversationId}/messages`, headers })).statusCode).toBe(404);
    authorized = [grants[1]];
    try {
      expect((await app.inject({ url: mediaUrl, headers })).statusCode).toBe(404);
      expect((await app.inject({ url: `${base}/messages`, headers })).statusCode).toBe(404);
      const response = await app.inject({ url: "/supervision/summary", headers });
      expect(response.json().sellers).toHaveLength(1);
      authorized = [];
      expect((await app.inject({ url: mediaUrl, headers })).statusCode).toBe(403);
    } finally { authorized = grants; }
  });
});
