import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supervisionPageSchema, supervisionSummarySchema, type SupervisionGrant } from "@prymeira-talk/shared";
import { createSupervisionService } from "./supervision.service.js";
import { saoPauloDayStart } from "./supervision-insights.js";

const databaseUrl = process.env.SUPERVISION_TEST_DATABASE_URL;
const workspaceId = randomUUID(), channelId = randomUUID(), sellerId = randomUUID();
const grants: SupervisionGrant[] = [{ id: randomUUID(), supervisor_customer_id: randomUUID(), seller_customer_id: sellerId,
  seller_name: "Junior", seller_email: "vendas5@example.test", workspace_id: workspaceId, channel_id: channelId }];
// 15:00 in Brazil.
const now = new Date("2026-10-03T18:00:00Z");
const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);

describe.skipIf(!databaseUrl)("supervision insights on PostgreSQL", () => {
  let prisma: PrismaClient;
  const ids: Record<string, string> = {};
  async function conversation(name: string, messages: Array<[number, "inbound" | "outbound", Record<string, unknown>?]>, extra: { isGroup?: boolean; status?: "open" | "closed" } = {}) {
    const contact = await prisma.contact.create({ data: { workspaceId, phone: `5547${Math.floor(Math.random() * 1e9)}`, name, isGroup: extra.isGroup ?? false } });
    const record = await prisma.conversation.create({ data: { workspaceId, channelId, contactId: contact.id, status: extra.status ?? "open",
      lastMessageAt: at(Math.min(...messages.map(([minutes]) => minutes))) } });
    for (const [minutes, direction, metadata] of messages) await prisma.message.create({ data: { workspaceId, conversationId: record.id,
      direction, type: "text", status: direction === "outbound" ? "sent" : "delivered", body: "x", createdAt: at(minutes), metadata: (metadata ?? {}) as object } });
    ids[name] = record.id;
  }
  beforeAll(async () => {
    if (!new URL(databaseUrl!).pathname.endsWith("_test")) throw new Error("Integration tests require a disposable *_test database.");
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.channel.create({ data: { id: channelId, workspaceId, provider: "evolution", providerKey: `k-${channelId}`, displayName: "Vendas", phoneNumber: "5547999990000" } });
    // Wrote twice, 90 and 60 minutes ago, never answered: waiting since the first one.
    await conversation("Esperando", [[300, "inbound"], [280, "outbound"], [90, "inbound"], [60, "inbound"]]);
    // Answered in 4 minutes: not waiting.
    await conversation("Respondido", [[30, "inbound"], [26, "outbound"]]);
    // Our last real message was an answer; the customer's reaction does not reopen the wait.
    await conversation("Reagiu", [[50, "inbound"], [40, "outbound"], [10, "inbound", { reaction: { targetId: "W1", emoji: "👍" } }]]);
    // Groups and closed chats are not a seller's queue.
    await conversation("Grupo", [[20, "inbound"]], { isGroup: true });
    await conversation("Encerrada", [[20, "inbound"]], { status: "closed" });
  }, 30_000);
  afterAll(async () => {
    if (!prisma) return;
    await prisma.message.deleteMany({ where: { workspaceId } });
    await prisma.conversation.deleteMany({ where: { workspaceId } });
    await prisma.contact.deleteMany({ where: { workspaceId } });
    await prisma.channel.deleteMany({ where: { workspaceId } });
    await prisma.$disconnect();
  });

  it("finds who is waiting, since their first unanswered message, ignoring reactions, groups and closed chats", async () => {
    const service = createSupervisionService(prisma, () => now);
    const page = supervisionPageSchema.parse(await service.list(grants, { waiting: true }));
    expect(page.conversations.map(row => row.contactName)).toEqual(["Esperando"]);
    expect(page.conversations[0]!.waitingSince).toBe(at(90).toISOString());
  });
  it("summarises the team: waiting count, longest wait and today's work with the median first answer", async () => {
    const service = createSupervisionService(prisma, () => now);
    const [seller] = supervisionSummarySchema.parse(await service.summary(grants)).sellers;
    expect(seller).toMatchObject({ waitingCount: 1, oldestWaitingSince: at(90).toISOString() });
    // Today (since 03:00 UTC): bursts answered after 20 min (300→280), 4 min (30→26) and 10 min (50→40): median 10 min.
    // A chat closed today was still worked today; the group and the reaction are not counted.
    expect(seller!.today).toEqual({ received: 6, sent: 3, conversations: 4, medianResponseSeconds: 600 });
  });
  it("marks the waiting conversation in an ordinary page", async () => {
    const service = createSupervisionService(prisma, () => now);
    const page = await service.list(grants, { status: "active" });
    expect(page.conversations.find(row => row.contactName === "Esperando")?.waitingSince).toBe(at(90).toISOString());
    expect(page.conversations.find(row => row.contactName === "Respondido")?.waitingSince).toBeNull();
  });
  it("'não precisa responder' takes a customer out of the queue until they write again; undo brings them back", async () => {
    const service = createSupervisionService(prisma, () => now);
    const waiting = async () => (await service.list(grants, { waiting: true })).conversations.map(row => [row.contactName, row.waitingSince]);
    await service.setWaitingDismissed(grants, workspaceId, ids.Esperando!, true);
    expect(await waiting()).toEqual([]);
    expect((await service.summary(grants)).sellers[0]).toMatchObject({ waitingCount: 0 });
    const next = await prisma.message.create({ data: { workspaceId, conversationId: ids.Esperando!, direction: "inbound", type: "text",
      status: "delivered", body: "e aí?", createdAt: at(5) } });
    expect(await waiting()).toEqual([["Esperando", at(5).toISOString()]]);
    await prisma.message.delete({ where: { id: next.id } });
    await service.setWaitingDismissed(grants, workspaceId, ids.Esperando!, false);
    expect(await waiting()).toEqual([["Esperando", at(90).toISOString()]]);
    await expect(service.setWaitingDismissed(grants, workspaceId, randomUUID(), true)).rejects.toMatchObject({ statusCode: 404 });
  });
  it("starts the team's day at midnight in Brazil", () => {
    expect(saoPauloDayStart(new Date("2026-10-04T02:30:00Z")).toISOString()).toBe("2026-10-03T03:00:00.000Z");
    expect(saoPauloDayStart(new Date("2026-10-04T03:30:00Z")).toISOString()).toBe("2026-10-04T03:00:00.000Z");
  });
});
