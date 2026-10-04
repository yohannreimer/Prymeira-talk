import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { conversationsRoutes } from "./conversations.routes.js";

const databaseUrl = process.env.SUPERVISION_TEST_DATABASE_URL;
const workspaceId = randomUUID(), otherWorkspaceId = randomUUID(), channelId = randomUUID(), otherChannelId = randomUUID();
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe.skipIf(!databaseUrl)("forwarding a message to other conversations", () => {
  let prisma: PrismaClient; let app: ReturnType<typeof Fastify>;
  let source: string; let targets: string[]; let foreign: string; let textId: string; let imageId: string;
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.channel.createMany({ data: [
      { id: channelId, workspaceId, provider: "evolution", providerKey: `k-${channelId}`, displayName: "Vendas", status: "connected" },
      { id: otherChannelId, workspaceId: otherWorkspaceId, provider: "evolution", providerKey: `k-${otherChannelId}`, displayName: "Outro", status: "connected" }] });
    const conversation = async (ws: string, ch: string, phone: string) => (await prisma.conversation.create({ data: { workspaceId: ws, channelId: ch,
      contactId: (await prisma.contact.create({ data: { workspaceId: ws, phone, name: phone } })).id } })).id;
    source = await conversation(workspaceId, channelId, "5547999990011");
    targets = [await conversation(workspaceId, channelId, "5547999990012"), await conversation(workspaceId, channelId, "5547999990013")];
    foreign = await conversation(otherWorkspaceId, otherChannelId, "5547999990014");
    textId = (await prisma.message.create({ data: { workspaceId, conversationId: source, direction: "inbound", type: "text", body: "Segue o orçamento da obra", status: "delivered" } })).id;
    imageId = (await prisma.message.create({ data: { workspaceId, conversationId: source, direction: "inbound", type: "image", body: "Imagem recebida", mediaUrl: png, status: "delivered",
      metadata: { attachment: { fileName: "planta.png", mimeType: "image/png", caption: "Planta baixa" } } } })).id;
    app = Fastify();
    app.decorate("prisma", prisma);
    app.decorate("realtime", { publish: vi.fn() } as never);
    app.addHook("preHandler", async request => { request.talk = { workspaceId, role: "agent", clerkUserId: null }; });
    await app.register(conversationsRoutes, {});
  }, 30_000);
  afterAll(async () => {
    await app?.close();
    if (!prisma) return;
    for (const id of [workspaceId, otherWorkspaceId]) {
      await prisma.message.deleteMany({ where: { workspaceId: id } }); await prisma.conversation.deleteMany({ where: { workspaceId: id } });
      await prisma.contact.deleteMany({ where: { workspaceId: id } }); await prisma.channel.deleteMany({ where: { workspaceId: id } });
    }
    await prisma.$disconnect();
  });
  const forward = (messageId: string, targetConversationIds: string[]) =>
    app.inject({ method: "POST", url: `/conversations/${source}/messages/${messageId}/forward`, payload: { targetConversationIds } });

  it("sends the text again to each chosen conversation, marked as forwarded for the team", async () => {
    const response = await forward(textId, targets);
    expect(response.statusCode).toBe(200);
    expect(response.json().results).toEqual(targets.map(conversationId => ({ conversationId, ok: true })));
    for (const conversationId of targets) {
      const stored = await prisma.message.findFirstOrThrow({ where: { workspaceId, conversationId } });
      expect(stored).toMatchObject({ direction: "outbound", type: "text", body: "Segue o orçamento da obra" });
      expect(stored.metadata).toMatchObject({ forwarded: { fromConversationId: source, fromMessageId: textId } });
    }
  });
  it("forwards a file with its name and caption", async () => {
    expect((await forward(imageId, [targets[0]!])).statusCode).toBe(200);
    const stored = await prisma.message.findFirstOrThrow({ where: { workspaceId, conversationId: targets[0], type: "image" } });
    expect(stored.mediaUrl).toBe(png);
    expect(stored.metadata).toMatchObject({ attachment: { fileName: "planta.png", mimeType: "image/png", caption: "Planta baixa" }, forwarded: { fromMessageId: imageId } });
  });
  it("never reaches a conversation of another workspace", async () => {
    const response = await forward(textId, [foreign]);
    expect(response.statusCode).toBe(502);
    expect(response.json().results[0]).toMatchObject({ ok: false });
    expect(await prisma.message.count({ where: { workspaceId: otherWorkspaceId } })).toBe(0);
  });
});
