import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { conversationsRoutes } from "./conversations.routes.js";

const databaseUrl = process.env.SUPERVISION_TEST_DATABASE_URL;
const workspaceId = randomUUID(), channelId = randomUUID();
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe.skipIf(!databaseUrl)("a big photo whose WhatsApp echo arrives before the send returns", () => {
  let prisma: PrismaClient; let app: ReturnType<typeof Fastify>; let conversationId: string;
  const client = {
    sendText: vi.fn().mockResolvedValue({ providerMessageId: "wa-text-1", raw: {} }),
    // Production's canonical ingress keeps the WhatsApp id only on the identity row, not on the message.
    echoAsCanonical: false,
    // While the upload is still going, the echo of this very message is stored by the ingress.
    sendMedia: vi.fn().mockImplementation(async () => {
      const id = client.echoAsCanonical ? "wa-photo-2" : "wa-photo-1";
      const echo = await prisma.message.create({ data: { workspaceId, conversationId, direction: "outbound", type: "image", body: "Imagem recebida", status: "read",
        providerMessageId: client.echoAsCanonical ? null : id, mediaUrl: "http://waha:3000/api/files/photo.png", metadata: { attachment: { mimeType: "image/png", width: 1, height: 1 } } } });
      if (client.echoAsCanonical) {
        const address = await prisma.canonicalAddress.create({ data: { workspaceId, channelId } });
        const chat = await prisma.canonicalChat.create({ data: { workspaceId, channelId, addressId: address.id } });
        await prisma.canonicalMessageIdentity.create({ data: { workspaceId, channelId, chatId: chat.id, conversationId, messageId: echo.id, identityFormat: "whatsapp",
          providerScope: "test", rawId: id, direction: "outbound", tupleHash: "a".repeat(64), fullTuple: {}, initialMode: "live" } });
      }
      return { providerMessageId: id, raw: {} };
    })
  };
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.channel.create({ data: { id: channelId, workspaceId, provider: "evolution", providerKey: `k-${channelId}`, displayName: "Pessoal", status: "connected" } });
    const contact = await prisma.contact.create({ data: { workspaceId, phone: "5547999460000", name: "Mãe" } });
    conversationId = (await prisma.conversation.create({ data: { workspaceId, channelId, contactId: contact.id } })).id;
    app = Fastify();
    app.decorate("prisma", prisma);
    app.decorate("realtime", { publish: vi.fn() } as never);
    app.addHook("preHandler", async (request: import("fastify").FastifyRequest) => { request.talk = { workspaceId, role: "agent", clerkUserId: null }; });
    await app.register(conversationsRoutes, { evolution: { mode: "real", client } as never });
  }, 30_000);
  afterAll(async () => {
    await app?.close();
    if (!prisma) return;
    await prisma.canonicalMessageIdentity.deleteMany({ where: { workspaceId } }); await prisma.canonicalChat.deleteMany({ where: { workspaceId } });
    await prisma.canonicalAddress.deleteMany({ where: { workspaceId } }); await prisma.message.deleteMany({ where: { workspaceId } }); await prisma.conversation.deleteMany({ where: { workspaceId } });
    await prisma.contact.deleteMany({ where: { workspaceId } }); await prisma.channel.deleteMany({ where: { workspaceId } });
    await prisma.$disconnect();
  });

  it("completes the echo instead of storing the photo twice", async () => {
    const response = await app.inject({ method: "POST", url: `/conversations/${conversationId}/messages`,
      payload: { attachment: { fileName: "Imagem do ChatGPT.png", mimetype: "image/png", mediaUrl: png } } });
    expect(response.statusCode).toBe(201);
    const rows = await prisma.message.findMany({ where: { workspaceId, conversationId } });
    expect(rows).toHaveLength(1);
    expect(response.json().id).toBe(rows[0]!.id);
    expect(rows[0]).toMatchObject({ providerMessageId: "wa-photo-1", status: "read", mediaUrl: "http://waha:3000/api/files/photo.png" });
    expect(rows[0]!.metadata).toMatchObject({ attachment: { fileName: "Imagem do ChatGPT.png", mimeType: "image/png", width: 1 } });
  });
  it("also when the echo carries the WhatsApp id only on its identity (canonical ingress)", async () => {
    await prisma.message.deleteMany({ where: { workspaceId } }); client.echoAsCanonical = true;
    const response = await app.inject({ method: "POST", url: `/conversations/${conversationId}/messages`,
      payload: { attachment: { fileName: "foto.png", mimetype: "image/png", mediaUrl: png } } });
    expect(response.statusCode).toBe(201);
    const rows = await prisma.message.findMany({ where: { workspaceId, conversationId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ providerMessageId: "wa-photo-2", status: "read" });
  });
});
