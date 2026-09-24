import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { previewCampaignAudience } from "./campaign-audience-preview.js";
import { createCampaignActivationService } from "./campaign-activation.service.js";
import { createCampaignWorker } from "./campaign-worker.js";
import { createCampaignControlsService } from "./campaign-controls.service.js";

const url = process.env.CAMPAIGN_INTEGRATION_DATABASE_URL;
const safe = url ? (() => {
  const parsed = new URL(url);
  return ["127.0.0.1", "localhost"].includes(parsed.hostname) &&
    parsed.pathname === "/campaign_test";
})() : false;

describe.skipIf(!safe)("campaign queue with disposable PostgreSQL", () => {
  let prisma: PrismaClient;
  const workspaceId = `campaign-test-${randomUUID()}`;
  const channelId = randomUUID();
  let campaignId = "";
  let current = new Date("2026-09-22T13:00:00.000Z"); // 10:00 São Paulo
  const now = () => current;
  const sendText = vi.fn(async () => ({ providerMessageId: randomUUID(), raw: {} }));
  const checkWhatsappNumbersAvailability = vi.fn(async ({ numbers }: { numbers: string[] }) => ({
    numbers: numbers.map((phone) => ({ phone, available: true })), raw: {}
  }));

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: url! } } });
    await prisma.channel.create({ data: { id: channelId, workspaceId, provider: "evolution",
      providerKey: `test-${channelId}`, status: "connected" } });
    const campaign = await prisma.campaign.create({ data: { workspaceId, name: "Teste isolado",
      audience: { type: "imported", rows: [] }, messageBody: "Olá {{nome}}",
      templates: ["Olá {{nome}}"], cadence: { minDelaySeconds: 120,
        maxDelaySeconds: 300, batchSize: 20, pauseMinSeconds: 900,
        pauseMaxSeconds: 1200, windowStart: "09:00", windowEnd: "20:00" } } });
    campaignId = campaign.id;
  });
  afterAll(async () => {
    await prisma.message.deleteMany({ where: { workspaceId } });
    await prisma.conversation.deleteMany({ where: { workspaceId } });
    await prisma.campaign.deleteMany({ where: { workspaceId } });
    await prisma.campaignChannelThrottle.deleteMany({ where: { workspaceId } });
    await prisma.contact.deleteMany({ where: { workspaceId } });
    await prisma.channel.deleteMany({ where: { workspaceId } });
    await prisma.$disconnect();
  });

  it("activates once, serializes sends and persists actual pacing", async () => {
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    const contacts = ["5547999999999", "5547888888888"].map((phone, index) => ({
      contactId: null, audienceKey: phone, name: index ? "Bia" : "Ana", phone, fields: {}
    }));
    const preview = await previewCampaignAudience({ campaign, channelId, contacts,
      verify: async (numbers) => numbers.map((phone) => ({ phone, available: true })), now });
    const activation = createCampaignActivationService(prisma, { now, draw: (min) => min });
    const request = { workspaceId, campaignId, actorId: "test-user", idempotencyKey: randomUUID(),
      channelId, startMode: "now" as const, scheduledAt: null,
      timeZone: "America/Sao_Paulo", confirmation: true as const,
      expectedAudienceHash: preview.audienceHash, preview };
    const first = await activation.activate(request);
    expect(first.status).toBe("sending");
    expect((await activation.activate(request)).id).toBe(first.id);
    expect(await prisma.campaignRecipient.count({ where: { workspaceId, campaignId } })).toBe(2);
    expect(sendText).not.toHaveBeenCalled();

    const worker1 = createCampaignWorker({ prisma, evolution: {
      sendText, checkWhatsappNumbersAvailability }, now, draw: (min) => min });
    const worker2 = createCampaignWorker({ prisma, evolution: {
      sendText, checkWhatsappNumbersAvailability }, now, draw: (min) => min });
    await Promise.all([worker1.processOne(), worker2.processOne()]);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(await prisma.message.count({ where: { workspaceId } })).toBe(1);
    expect(await worker2.processOne()).toBe(false);
    const throttle = await prisma.campaignChannelThrottle.findUniqueOrThrow({ where: {
      workspaceId_channelId: { workspaceId, channelId } } });
    expect(throttle.nextAvailableAt?.getTime()).toBe(current.getTime() + 120_000);
    current = new Date(throttle.nextAvailableAt!.getTime() + 1_000);
    await worker2.processOne();
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(await prisma.message.count({ where: { workspaceId } })).toBe(2);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status)
      .toBe("completed");
  });

  it("pauses before claim, cancels only pending jobs, and never retries ambiguous sends", async () => {
    const otherChannelId = randomUUID();
    await prisma.channel.create({ data: { id: otherChannelId, workspaceId,
      provider: "evolution", providerKey: `test-${otherChannelId}`, status: "connected" } });
    const makeActive = async (phone: string) => {
      const campaign = await prisma.campaign.create({ data: { workspaceId,
        name: "Controle isolado", audience: { type: "imported", rows: [] },
        messageBody: "Olá", templates: ["Olá"], cadence: { minDelaySeconds: 120,
          maxDelaySeconds: 300, batchSize: 20, pauseMinSeconds: 900,
          pauseMaxSeconds: 1200, windowStart: "09:00", windowEnd: "20:00" } } });
      const preview = await previewCampaignAudience({ campaign, channelId: otherChannelId,
        contacts: [{ contactId: null, audienceKey: phone, name: null, phone, fields: {} }],
        verify: async (numbers) => numbers.map((value) => ({ phone: value, available: true })), now });
      await createCampaignActivationService(prisma, { now, draw: (min) => min }).activate({
        workspaceId, campaignId: campaign.id, actorId: "test-user",
        idempotencyKey: randomUUID(), channelId: otherChannelId,
        startMode: "now", scheduledAt: null, timeZone: "America/Sao_Paulo",
        confirmation: true, expectedAudienceHash: preview.audienceHash, preview
      });
      return campaign.id;
    };
    const pausedId = await makeActive("5547777777777");
    const controls = createCampaignControlsService(prisma, { now });
    expect((await controls.pause(workspaceId, pausedId)).status).toBe("paused");
    const worker = createCampaignWorker({ prisma, evolution: {
      sendText, checkWhatsappNumbersAvailability }, now });
    expect(await worker.processOne()).toBe(false);
    expect((await controls.cancelRemaining(workspaceId, pausedId)).pending).toBe(0);
    expect((await prisma.campaignRecipient.findFirstOrThrow({ where: {
      workspaceId, campaignId: pausedId } })).status).toBe("canceled");

    const uncertainId = await makeActive("5547666666666");
    const failingSend = vi.fn(async () => { throw new Error("timeout after send attempt"); });
    const uncertainWorker = createCampaignWorker({ prisma, evolution: {
      sendText: failingSend, checkWhatsappNumbersAvailability }, now });
    await uncertainWorker.processOne();
    expect((await controls.progress(workspaceId, uncertainId)).uncertain).toBe(1);
    expect((await controls.progress(workspaceId, uncertainId)).status).toBe("needs_attention");
    expect(await uncertainWorker.processOne()).toBe(false);
    expect(failingSend).toHaveBeenCalledTimes(1);
    const uncertainRecipient = await prisma.campaignRecipient.findFirstOrThrow({ where: {
      workspaceId, campaignId: uncertainId, status: "uncertain" } });
    const reviewed = await controls.resolveUncertain({ workspaceId, campaignId: uncertainId,
      recipientId: uncertainRecipient.id, actorId: "reviewer-1", outcome: "not_sent" });
    expect(reviewed.uncertain).toBe(0);
    expect(reviewed.status).toBe("completed");
    expect((await prisma.campaignRecipient.findUniqueOrThrow({ where: {
      id: uncertainRecipient.id } })).result).toMatchObject({ manualReview: true,
      reviewedBy: "reviewer-1", outcome: "not_sent" });
    expect(failingSend).toHaveBeenCalledTimes(1);
  });

  it("keeps a future start outside the window and preserves sampled gaps on resume", async () => {
    const scheduledChannelId = randomUUID();
    await prisma.channel.create({ data: { id: scheduledChannelId, workspaceId,
      provider: "evolution", providerKey: `test-${scheduledChannelId}`, status: "connected" } });
    const campaign = await prisma.campaign.create({ data: { workspaceId,
      name: "Agendamento isolado", audience: { type: "imported", rows: [] },
      messageBody: "Olá", templates: ["Olá"], cadence: { minDelaySeconds: 120,
        maxDelaySeconds: 300, batchSize: 20, pauseMinSeconds: 900,
        pauseMaxSeconds: 1200, windowStart: "09:00", windowEnd: "20:00" } } });
    const preview = await previewCampaignAudience({ campaign, channelId: scheduledChannelId,
      contacts: ["5547555555555", "5547444444444"].map((phone) => ({
        contactId: null, audienceKey: phone, name: null, phone, fields: {}
      })), verify: async (numbers) => numbers.map((phone) => ({ phone, available: true })), now });
    const effective = await createCampaignActivationService(prisma, { now,
      draw: (min) => min + 30 }).activate({ workspaceId, campaignId: campaign.id,
      actorId: "test-user", idempotencyKey: randomUUID(), channelId: scheduledChannelId,
      startMode: "scheduled", scheduledAt: "2026-09-22T23:05:00.000Z", // 20:05 local
      timeZone: "America/Sao_Paulo", confirmation: true,
      expectedAudienceHash: preview.audienceHash, preview });
    expect(effective.status).toBe("scheduled");
    expect(effective.scheduledAt?.toISOString()).toBe("2026-09-23T12:00:00.000Z");
    const before = await prisma.campaignRecipient.findMany({ where: { campaignId: campaign.id },
      orderBy: { sequenceNumber: "asc" } });
    expect(before.map((row) => row.gapSeconds)).toEqual([150, 150]);
    const controls = createCampaignControlsService(prisma, { now });
    await controls.pause(workspaceId, campaign.id);
    await controls.resume(workspaceId, campaign.id);
    const after = await prisma.campaignRecipient.findMany({ where: { campaignId: campaign.id },
      orderBy: { sequenceNumber: "asc" } });
    expect(after.map((row) => row.gapSeconds)).toEqual([150, 150]);
    const worker = createCampaignWorker({ prisma, evolution: {
      sendText, checkWhatsappNumbersAvailability }, now });
    expect(await worker.processOne()).toBe(false);
    current = new Date("2026-09-23T12:00:00.000Z");
    sendText.mockClear();
    await worker.processOne();
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(await worker.processOne()).toBe(false);
  });
});
