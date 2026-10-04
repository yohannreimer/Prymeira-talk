import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupervisionGrant } from "@prymeira-talk/shared";
import { authContextPlugin } from "../../plugins/auth-context.js";
import { conversationsRoutes } from "../conversations/conversations.routes.js";
import { supervisionRoutes } from "./supervision.routes.js";

const databaseUrl = process.env.SUPERVISION_TEST_DATABASE_URL;
const workspaceId = randomUUID(), otherWorkspaceId = randomUUID(), channelId = randomUUID(), otherChannelId = randomUUID(), supervisorId = randomUUID();
const grants: SupervisionGrant[] = [{ id: randomUUID(), supervisor_customer_id: supervisorId, seller_customer_id: randomUUID(),
  seller_name: "Junior", seller_email: "vendas5@example.test", workspace_id: workspaceId, channel_id: channelId }];

describe.skipIf(!databaseUrl)("a supervisor answering in a seller's conversation", () => {
  let prisma: PrismaClient; let app: ReturnType<typeof Fastify>;
  let conversationId: string; let foreignConversationId: string;
  const publish = vi.fn();
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.channel.createMany({ data: [
      { id: channelId, workspaceId, provider: "evolution", providerKey: `k-${channelId}`, displayName: "Vendas", status: "connected" },
      { id: otherChannelId, workspaceId: otherWorkspaceId, provider: "evolution", providerKey: `k-${otherChannelId}`, displayName: "Outro", status: "connected" }] });
    const contact = await prisma.contact.create({ data: { workspaceId, phone: "5547999990001", name: "Jackson" } });
    conversationId = (await prisma.conversation.create({ data: { workspaceId, channelId, contactId: contact.id } })).id;
    const foreign = await prisma.contact.create({ data: { workspaceId: otherWorkspaceId, phone: "5547999990002", name: "Outro" } });
    foreignConversationId = (await prisma.conversation.create({ data: { workspaceId: otherWorkspaceId, channelId: otherChannelId, contactId: foreign.id } })).id;
    app = Fastify();
    app.decorate("prisma", prisma);
    app.decorate("realtime", { publish } as never);
    await app.register(authContextPlugin, { accountApiUrl: "http://hub.test", productKey: "talk",
      fetch: vi.fn().mockImplementation(async () => new Response(JSON.stringify({ grants }))) });
    await app.register(conversationsRoutes, {});
    await app.register(supervisionRoutes);
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
  const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload, headers: { authorization: "Bearer supervisor" } });

  it("sends through the seller's conversation, marked as the supervisor's answer, and pauses the agent like any human reply", async () => {
    const response = await post(`/supervision/workspaces/${workspaceId}/conversations/${conversationId}/messages`, { body: "Oi Jackson, aqui é o gerente. Já te retorno." });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ direction: "outbound", body: "Oi Jackson, aqui é o gerente. Já te retorno.", sentBySupervisor: true });
    const stored = await prisma.message.findFirstOrThrow({ where: { workspaceId, conversationId } });
    expect(stored.metadata).toMatchObject({ supervisorReply: { supervisorCustomerId: supervisorId } });
    expect((await prisma.conversation.findFirstOrThrow({ where: { id: conversationId } })).aiControlStatus).toBe("human_controlled");
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "message.created", workspaceId }));
  });
  it("never answers outside the supervised sellers, nor with attachments", async () => {
    expect((await post(`/supervision/workspaces/${otherWorkspaceId}/conversations/${foreignConversationId}/messages`, { body: "oi" })).statusCode).toBe(404);
    expect((await post(`/supervision/workspaces/${workspaceId}/conversations/${conversationId}/messages`, { body: "x", attachment: { fileName: "a.pdf", mimetype: "application/pdf", mediaUrl: "data:application/pdf;base64,YQ==" } })).statusCode).toBe(400);
    expect(await prisma.message.count({ where: { workspaceId: otherWorkspaceId } })).toBe(0);
  });
  it("keeps every other supervision action read only", async () => {
    expect((await post(`/supervision/workspaces/${workspaceId}/conversations/${conversationId}/messages/x/delete`, {})).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/supervision/workspaces/${workspaceId}/conversations/${conversationId}/messages`, headers: { authorization: "Bearer supervisor" } })).statusCode).toBe(403);
  });
});
