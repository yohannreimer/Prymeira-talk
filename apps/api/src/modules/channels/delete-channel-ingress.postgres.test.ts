import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createChannelsService, type PrismaLike } from "./channels.service.js";

const databaseUrl = process.env.SUPERVISION_TEST_DATABASE_URL;
const workspaceId = randomUUID(), channelId = randomUUID(), keptChannelId = randomUUID();

describe.skipIf(!databaseUrl)("deleting a channel that already went through the ingress", () => {
  let prisma: PrismaClient;
  const receipt = (channel: string) => ({ id: randomUUID(), workspaceId, channelId: channel, stageVersion: 1, transportNamespace: "evolution", source: {},
    authentication: "hmac", authenticatedDigest: "a", rawRef: "raw", rawDigest: "b", eventRef: "ev", eventDigest: "c", eventCount: 1 });
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.channel.createMany({ data: [
      { id: channelId, workspaceId, provider: "evolution", providerKey: `k-${channelId}`, displayName: "Vendas 2", status: "disconnected" },
      { id: keptChannelId, workspaceId, provider: "evolution", providerKey: `k-${keptChannelId}`, displayName: "Vendas 02", status: "connected" }] });
    const contact = await prisma.contact.create({ data: { workspaceId, phone: "5547999001698", name: "Cliente" } });
    const conversation = await prisma.conversation.create({ data: { workspaceId, channelId, contactId: contact.id } });
    await prisma.message.create({ data: { workspaceId, conversationId: conversation.id, direction: "inbound", type: "text", body: "oi", status: "delivered" } });
    await prisma.ingressReceipt.createMany({ data: [receipt(channelId), receipt(channelId), receipt(keptChannelId)] });
  }, 30_000);
  afterAll(async () => {
    if (!prisma) return;
    await prisma.ingressReceipt.deleteMany({ where: { workspaceId } }); await prisma.message.deleteMany({ where: { workspaceId } });
    await prisma.conversation.deleteMany({ where: { workspaceId } }); await prisma.contact.deleteMany({ where: { workspaceId } });
    await prisma.channel.deleteMany({ where: { workspaceId } }); await prisma.$disconnect();
  });

  it("removes the channel with its ingress receipts and conversations, and only that channel", async () => {
    const service = createChannelsService(prisma as unknown as PrismaLike);
    await expect(service.deleteChannel({ workspaceId, channelId, confirmationName: "Vendas 2" })).resolves.toEqual({ channelId });
    expect(await prisma.channel.count({ where: { workspaceId, id: channelId } })).toBe(0);
    expect(await prisma.ingressReceipt.count({ where: { workspaceId, channelId } })).toBe(0);
    expect(await prisma.conversation.count({ where: { workspaceId, channelId } })).toBe(0);
    expect(await prisma.ingressReceipt.count({ where: { workspaceId, channelId: keptChannelId } })).toBe(1);
    expect(await prisma.channel.count({ where: { workspaceId, id: keptChannelId } })).toBe(1);
  });
});
