import { describe, expect, it, vi } from "vitest";
import {
  META_FIRST_MESSAGE_BLOCKED_REASON,
  createAutomationWebhookService,
  generateAutomationWebhookToken,
  isWellFormedAutomationWebhookToken,
  normalizeWebhookPhone,
  parseWebhookSubmission,
  webhookSubmissionFingerprint,
  type AutomationWebhookPrismaLike
} from "./automation-webhook.service.js";
import type { AutomationRuleRecord } from "./automation-runner.js";

const workspaceId = "workspace_a";
const ruleId = "00000000-0000-4000-8000-000000000101";
const channelId = "00000000-0000-4000-8000-000000000501";
const contactId = "00000000-0000-4000-8000-000000000401";
const conversationId = "00000000-0000-4000-8000-000000000301";
const messageId = "00000000-0000-4000-8000-000000000201";
const token = "a".repeat(43);
const now = new Date("2026-10-11T12:00:00.000Z");

function webhookRule(overrides: Partial<AutomationRuleRecord> = {}, config: Record<string, unknown> = { channelId }) {
  return {
    id: ruleId,
    workspaceId,
    name: "Leads do site",
    status: "enabled",
    trigger: "webhook.received",
    conditions: {},
    actions: {
      version: 1,
      nodes: [
        {
          id: "trigger-1",
          type: "trigger_webhook",
          position: { x: 0, y: 0 },
          data: { title: "Webhook externo", config }
        }
      ],
      edges: []
    },
    createdAt: now,
    updatedAt: now,
    ...overrides
  } as AutomationRuleRecord;
}

function tokenRecord(value = token) {
  return { id: "token-row", workspaceId, ruleId, token: value, createdAt: now, updatedAt: now };
}

function createMockPrisma() {
  const runs = new Map<string, Record<string, unknown>>();
  const prisma = {
    $executeRaw: vi.fn(),
    automationRule: { findFirst: vi.fn().mockResolvedValue(webhookRule()) },
    automationWebhookToken: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async (args: { data: { token: string } }) => tokenRecord(args.data.token)),
      upsert: vi.fn().mockImplementation(async (args: { update: { token: string } }) => tokenRecord(args.update.token))
    },
    automationRun: {
      findFirst: vi.fn().mockImplementation(async (args: { where: { eventKey?: string; createdAt?: unknown } }) => args.where.createdAt ? null : runs.get(args.where.eventKey!) ?? { id: 'run-1', workspaceId, ruleId, eventKey: args.where.eventKey, status: 'queued', input: {} }),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => { runs.set(String(args.data.eventKey), { id: 'run-1', ...args.data }); return { id: 'run-1', ...args.data }; }),
      update: vi.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => { const key = String((args.data.input as Record<string, unknown> | undefined)?.eventKey ?? [...runs.keys()].at(-1) ?? 'webhook.received:abc:1'); const row = { ...(runs.get(key) ?? { id: 'run-1', workspaceId, ruleId, status: 'queued', eventKey: key }), ...args.data }; runs.set(key, row); return row; }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    channel: {
      findFirst: vi.fn().mockResolvedValue({
        id: channelId,
        workspaceId,
        provider: "evolution",
        providerKey: "talk-instance",
        displayName: "WhatsApp"
      })
    },
    contact: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async (args: { data: { phone: string; name?: string } }) => ({
        id: contactId,
        phone: args.data.phone,
        name: args.data.name ?? null
      })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    conversation: {
      upsert: vi.fn().mockResolvedValue({
        id: conversationId,
        workspaceId,
        channelId,
        contactId,
        status: "open",
        assignedUserId: null,
        departmentId: null,
        lastMessageAt: now,
        lastMessagePreview: "Formulário recebido (Webhook externo)",
        unreadCount: 1,
        priority: "normal",
        aiControlStatus: "agent_allowed",
        contact: { name: "Joana", phone: "554799991234" },
        channel: { provider: "evolution", displayName: "WhatsApp" }
      })
    },
    message: {
      create: vi.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => ({
        id: messageId,
        ...args.data,
        createdAt: now
      }))
    }
  };
  return Object.assign(prisma, { $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(prisma)) });
}

function createService(prisma = createMockPrisma(), runner = { runForWebhookEvent: vi.fn().mockResolvedValue({ id: "run-1" }) }) {
  const realtime = { publish: vi.fn() };
  const service = createAutomationWebhookService({
    prisma: prisma as unknown as AutomationWebhookPrismaLike,
    runner,
    realtime,
    generateToken: vi.fn().mockReturnValueOnce("b".repeat(43)).mockReturnValueOnce("c".repeat(43)),
    now: () => now
  });

  return { service, prisma, runner, realtime };
}

function okSubmission(body: unknown) {
  const parsed = parseWebhookSubmission(body);
  if (!parsed.ok) throw new Error(`unexpected ${parsed.code}`);
  return parsed;
}

describe("automation webhook tokens", () => {
  it("generates unguessable url-safe tokens", () => {
    const first = generateAutomationWebhookToken();
    const second = generateAutomationWebhookToken();

    expect(first).not.toBe(second);
    expect(isWellFormedAutomationWebhookToken(first)).toBe(true);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isWellFormedAutomationWebhookToken("../../etc")).toBe(false);
  });

  it("creates the token once and returns the existing one afterwards", async () => {
    const { service, prisma } = createService();

    const created = await service.getOrCreateWebhook({ workspaceId, automationId: ruleId });
    expect(created).toMatchObject({
      automationId: ruleId,
      token: "b".repeat(43),
      path: `/webhooks/automations/${"b".repeat(43)}`
    });
    expect(prisma.automationWebhookToken.create).toHaveBeenCalledWith({
      data: { workspaceId, ruleId, token: "b".repeat(43) }
    });

    prisma.automationWebhookToken.findUnique.mockResolvedValueOnce(tokenRecord("existing".padEnd(43, "x")));
    const existing = await service.getOrCreateWebhook({ workspaceId, automationId: ruleId });
    expect(existing.token).toBe("existing".padEnd(43, "x"));
    expect(prisma.automationWebhookToken.create).toHaveBeenCalledTimes(1);
  });

  it("regenerates the token, replacing the previous value", async () => {
    const { service, prisma } = createService();

    await service.getOrCreateWebhook({ workspaceId, automationId: ruleId });
    const regenerated = await service.regenerateWebhook({ workspaceId, automationId: ruleId });

    expect(regenerated.token).toBe("c".repeat(43));
    expect(prisma.automationWebhookToken.upsert).toHaveBeenCalledWith({
      where: { workspaceId_ruleId: { workspaceId, ruleId } },
      create: { workspaceId, ruleId, token: "c".repeat(43) },
      update: { token: "c".repeat(43) }
    });
  });

  it("refuses tokens for automations without the saved webhook trigger or from another workspace", async () => {
    const { service, prisma } = createService();

    prisma.automationRule.findFirst.mockResolvedValueOnce(
      webhookRule({ actions: { version: 1, nodes: [], edges: [] } })
    );
    await expect(service.getOrCreateWebhook({ workspaceId, automationId: ruleId })).rejects.toMatchObject({
      code: "AUTOMATION_WEBHOOK_TRIGGER_MISSING"
    });

    prisma.automationRule.findFirst.mockResolvedValueOnce(null);
    await expect(service.regenerateWebhook({ workspaceId: "workspace_b", automationId: ruleId })).rejects.toMatchObject({
      code: "AUTOMATION_NOT_FOUND"
    });
    expect(prisma.automationRule.findFirst).toHaveBeenLastCalledWith({
      where: { workspaceId: "workspace_b", id: ruleId }
    });
    expect(prisma.automationWebhookToken.upsert).not.toHaveBeenCalled();
  });

  it("resolves only well-formed tokens of enabled automations that still use the webhook trigger", async () => {
    const { service, prisma } = createService();

    expect(await service.resolveToken("short")).toBeNull();
    expect(prisma.automationWebhookToken.findUnique).not.toHaveBeenCalled();

    expect(await service.resolveToken(token)).toBeNull();

    prisma.automationWebhookToken.findUnique.mockResolvedValueOnce({ ...tokenRecord(), rule: webhookRule({ status: "disabled" }) });
    expect(await service.resolveToken(token)).toBeNull();

    prisma.automationWebhookToken.findUnique.mockResolvedValueOnce({
      ...tokenRecord(),
      rule: webhookRule({ actions: { version: 1, nodes: [], edges: [] } })
    });
    expect(await service.resolveToken(token)).toBeNull();

    prisma.automationWebhookToken.findUnique.mockResolvedValueOnce({ ...tokenRecord(), rule: webhookRule() });
    expect(await service.resolveToken(token)).toMatchObject({ id: ruleId });
    expect(prisma.automationWebhookToken.findUnique).toHaveBeenLastCalledWith({
      where: { token },
      include: { rule: true }
    });
  });
});

describe("automation webhook submissions", () => {
  it("normalizes Brazilian phone numbers and rejects invalid ones", () => {
    expect(normalizeWebhookPhone("(47) 99999-1234")).toBe("5547999991234");
    expect(normalizeWebhookPhone("47 3433-1234")).toBe("554734331234");
    expect(normalizeWebhookPhone("+55 47 99999-1234")).toBe("5547999991234");
    expect(normalizeWebhookPhone(5547999991234)).toBe("5547999991234");
    expect(normalizeWebhookPhone("0055 47 99999 1234")).toBe("5547999991234");
    expect(normalizeWebhookPhone("+351 912 345 678")).toBe("351912345678");
    expect(normalizeWebhookPhone("12345")).toBeNull();
    expect(normalizeWebhookPhone("55 47 9999")).toBeNull();
    expect(normalizeWebhookPhone("")).toBeNull();
    expect(normalizeWebhookPhone({ phone: "47999991234" })).toBeNull();
  });

  it("reads the phone from whatsapp, telefone or phone and the name from nome or name", () => {
    expect(okSubmission({ whatsapp: "47999991234", nome: "  Joana   Silva " })).toMatchObject({
      phone: "5547999991234",
      name: "Joana Silva"
    });
    expect(okSubmission({ telefone: "47999991234", name: "Ana" })).toMatchObject({
      phone: "5547999991234",
      name: "Ana",
      variables: { nome: "Ana", name: "Ana" }
    });
    expect(okSubmission(JSON.stringify({ phone: "47999991234" }))).toMatchObject({ name: null });
    expect(parseWebhookSubmission({ nome: "Sem telefone" })).toEqual({ ok: false, code: "invalid_phone" });
    expect(parseWebhookSubmission({ whatsapp: "123" })).toEqual({ ok: false, code: "invalid_phone" });
    expect(parseWebhookSubmission(["47999991234"])).toEqual({ ok: false, code: "invalid_body" });
    expect(parseWebhookSubmission("not json")).toEqual({ ok: false, code: "invalid_body" });
  });

  it("fingerprints the same phone and payload identically regardless of key order and submit time", () => {
    const first = webhookSubmissionFingerprint("5547999991234", { nome: "Joana", dor: "Caixa", enviado_em: "1" });
    const second = webhookSubmissionFingerprint("5547999991234", { enviado_em: "2", dor: "Caixa", nome: "Joana" });
    const other = webhookSubmissionFingerprint("5547999991234", { nome: "Joana", dor: "Vendas" });

    expect(first).toBe(second);
    expect(first).not.toBe(other);
  });

  it("claims a submission once and ignores duplicates inside the dedupe window", async () => {
    const { service, prisma } = createService();
    const rule = webhookRule();
    const submission = okSubmission({ whatsapp: "47999991234", nome: "Joana" });

    const first = await service.claimSubmission({ rule, submission });
    expect(first).toMatchObject({ claimed: true });
    const eventKey = first.claimed ? first.eventKey : "";
    expect(eventKey).toMatch(/^webhook\.received:[a-f0-9]{40}:\d+$/);
    expect(prisma.automationRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId,
        ruleId,
        eventKey,
        status: "queued",
        input: expect.objectContaining({ source: "automation_webhook", phone: "5547999991234", submission: expect.objectContaining({ name: "Joana", variables: expect.any(Object) }) })
      })
    });
    const bucket = Number(eventKey.split(":").at(-1));
    expect(prisma.automationRun.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId,
        ruleId,
        eventKey: eventKey.replace(/:\d+$/, `:${bucket - 1}`),
        createdAt: { gte: new Date(now.getTime() - 10 * 60 * 1000) }
      },
      select: { id: true }
    });

    prisma.automationRun.create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    expect(await service.claimSubmission({ rule, submission })).toEqual({ claimed: false });

    prisma.automationRun.findFirst.mockResolvedValueOnce({ id: "previous-run" });
    expect(await service.claimSubmission({ rule, submission })).toEqual({ claimed: false });
    expect(prisma.automationRun.create).toHaveBeenCalledTimes(2);
  });

  it("creates the contact and conversation, records the form for the team and runs the flow", async () => {
    const { service, prisma, runner, realtime } = createService();
    const rule = webhookRule();
    const submission = okSubmission({
      nome: "Joana",
      whatsapp: "(47) 99999-1234",
      empresa: "Metalúrgica",
      equipe: ["Financeiro", "Comercial"],
      utm: { source: "instagram" }
    });

    await service.processSubmission({ rule, eventKey: "webhook.received:abc:1", submission });

    expect(prisma.channel.findFirst).toHaveBeenCalledWith({ where: { workspaceId, id: channelId } });
    expect(prisma.contact.findFirst).toHaveBeenCalledWith({
      where: { workspaceId, phone: { in: ["554799991234", "5547999991234"] } },
      orderBy: { updatedAt: "desc" }
    });
    expect(prisma.contact.create).toHaveBeenCalledWith({
      data: { workspaceId, phone: "554799991234", name: "Joana" }
    });
    expect(prisma.conversation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_channelId_contactId: { workspaceId, channelId, contactId } },
        create: expect.objectContaining({ workspaceId, channelId, contactId, status: "open" })
      })
    );
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId,
        conversationId,
        direction: "inbound",
        type: "system",
        status: "delivered",
        body: [
          "Formulário recebido (Webhook externo)",
          "Nome: Joana",
          "Whatsapp: (47) 99999-1234",
          "Empresa: Metalúrgica",
          "Equipe: Financeiro, Comercial",
          "Utm source: instagram"
        ].join("\n"),
        metadata: { source: "automation_webhook", automationId: ruleId, eventKey: "webhook.received:abc:1" }
      })
    });
    expect(realtime.publish).toHaveBeenCalledWith(expect.objectContaining({ type: "message.created" }));
    expect(realtime.publish).toHaveBeenCalledWith(expect.objectContaining({ type: "conversation.updated" }));
    expect(runner.runForWebhookEvent).toHaveBeenCalledWith({
      workspaceId,
      rule,
      messageId,
      eventKey: "webhook.received:abc:1",
      variables: expect.objectContaining({ nome: "Joana", empresa: "Metalúrgica", "utm.source": "instagram" }),
      outboundBlockedReason: null,
      runInput: expect.objectContaining({ phone: "5547999991234", payload: submission.payload, messageId })
    });
  });

  it("keeps an existing contact name and only fills an empty one", async () => {
    const { service, prisma } = createService();
    const rule = webhookRule();
    const submission = okSubmission({ nome: "Nome do formulário", whatsapp: "47999991234" });

    prisma.contact.findFirst.mockResolvedValueOnce({ id: contactId, phone: "554799991234", name: "Nome da equipe" });
    await service.processSubmission({ rule, eventKey: "k1", submission });
    expect(prisma.contact.create).not.toHaveBeenCalled();
    expect(prisma.contact.updateMany).not.toHaveBeenCalled();

    prisma.contact.findFirst.mockResolvedValueOnce({ id: contactId, phone: "554799991234", name: " " });
    await service.processSubmission({ rule, eventKey: "k2", submission });
    expect(prisma.contact.updateMany).toHaveBeenCalledWith({
      where: { workspaceId, id: contactId, OR: [{ name: null }, { name: "" }] },
      data: { name: "Nome do formulário" }
    });
  });

  it("reuses a contact created concurrently by another request", async () => {
    const { service, prisma } = createService();
    prisma.contact.create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    prisma.contact.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: contactId, phone: "554799991234", name: "Joana" });

    await service.processSubmission({
      rule: webhookRule(),
      eventKey: "k1",
      submission: okSubmission({ nome: "Joana", whatsapp: "47999991234" })
    });

    expect(prisma.conversation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId_channelId_contactId: { workspaceId, channelId, contactId } } })
    );
  });

  it("passes a clear Meta reason so sends are skipped instead of failing silently", async () => {
    const prisma = createMockPrisma();
    prisma.channel.findFirst.mockResolvedValueOnce({
      id: channelId,
      workspaceId,
      provider: "meta_cloud",
      providerKey: "phone-number-id",
      displayName: "Oficial"
    });
    const { service, runner } = createService(prisma);

    await service.processSubmission({
      rule: webhookRule(),
      eventKey: "k1",
      submission: okSubmission({ whatsapp: "47999991234" })
    });

    expect(runner.runForWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ outboundBlockedReason: META_FIRST_MESSAGE_BLOCKED_REASON })
    );
  });

  it("fails the claimed run with a readable reason when the channel is missing", async () => {
    const { service, prisma, runner } = createService();
    prisma.channel.findFirst.mockResolvedValueOnce(null);

    await service.processSubmission({
      rule: webhookRule(),
      eventKey: "k1",
      submission: okSubmission({ whatsapp: "47999991234" })
    });

    expect(runner.runForWebhookEvent).not.toHaveBeenCalled();
    expect(prisma.contact.create).not.toHaveBeenCalled();
    expect(prisma.automationRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "run-1", workspaceId, status: "queued", executionToken: null },
      data: expect.objectContaining({ status: "failed", result: expect.objectContaining({ error: "Canal do WhatsApp não encontrado. Escolha o canal no gatilho Webhook externo." }) })
    }));
  });

  it("keeps a transient preparation failure durably queued", async () => {
    const { service, prisma } = createService();
    prisma.conversation.upsert.mockRejectedValueOnce(new Error("database down"));

    await expect(
      service.processSubmission({
        rule: webhookRule(),
        eventKey: "k1",
        submission: okSubmission({ whatsapp: "47999991234" })
      })
    ).rejects.toThrow("database down");
    expect(prisma.automationRun.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }));
  });
});


it('exposes a durable recovery sweep after the accepting process disappears', async () => {
  const { service } = createService();
  expect(service.processDueSubmissions).toBeTypeOf('function');
});
