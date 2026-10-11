import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { automationWebhookRoutes } from "./automation-webhook.routes.js";

const url = process.env.AUTOMATION_WEBHOOK_TEST_DATABASE_URL;
// Explicit opt-in and local/disposable name required. Never use inherited DATABASE_URL.
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/automation_webhook_test(?:\?|$)/.test(url)) {
  throw new Error("Refusing a non-disposable automation webhook test database.");
}

describe.skipIf(!url)("automation webhook PostgreSQL integration", () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? "postgresql://invalid/unused" } } });
  const workspaceId = `automation-webhook-test-${randomUUID()}`;
  const tasks: Array<() => Promise<unknown>> = [];
  const agentRuntime = {
    activateForMessage: vi.fn().mockResolvedValue({ status: "completed", sessionId: "session-1" })
  };
  const agentReplyScheduler = {
    scheduleActiveSessionForMessage: vi.fn().mockResolvedValue({ scheduled: true, scheduledAt: new Date() })
  };
  const app = Fastify({ logger: false });
  let ruleId: string;
  let channelId: string;

  async function post(token: string, payload: unknown) {
    const response = await app.inject({ method: "POST", url: `/webhooks/automations/${token}`, payload: payload as object });
    while (tasks.length > 0) {
      await tasks.shift()!();
    }
    return response;
  }

  beforeAll(async () => {
    channelId = (await db.channel.create({
      data: { workspaceId, provider: "evolution", providerKey: `instance-${randomUUID()}`, displayName: "WhatsApp" }
    })).id;
    ruleId = (await db.automationRule.create({
      data: {
        workspaceId,
        name: "Leads do site",
        status: "enabled",
        trigger: "webhook.received",
        actions: {
          version: 1,
          nodes: [
            { id: "trigger-1", type: "trigger_webhook", position: { x: 0, y: 0 }, data: { title: "Webhook externo", config: { channelId } } },
            { id: "tag-1", type: "add_tag", position: { x: 260, y: 0 }, data: { title: "Tag", config: { tagName: "Lead do site" } } },
            { id: "send-1", type: "send_message", position: { x: 520, y: 0 }, data: { title: "Mensagem", config: { message: "Oi {{nome}}, vi aqui teu formulário sobre {{dor}}." } } },
            { id: "agent-1", type: "run_agent", position: { x: 780, y: 0 }, data: { title: "Agente", config: { agentId: randomUUID(), instruction: "Agende uma call com {{nome}}." } } }
          ],
          edges: [
            { id: "e1", source: "trigger-1", target: "tag-1" },
            { id: "e2", source: "tag-1", target: "send-1" },
            { id: "e3", source: "send-1", target: "agent-1" }
          ]
        }
      }
    })).id;

    app.decorate("prisma", db);
    app.decorate("realtime", { publish: vi.fn() } as never);
    app.decorateRequest("talk");
    app.addHook("onRequest", async (request) => {
      request.talk = { workspaceId, role: "owner" };
    });
    await app.register(automationWebhookRoutes, {
      agentRuntime,
      agentReplyScheduler,
      evolution: { mode: "simulated", client: null },
      schedule: (task) => {
        tasks.push(task);
      }
    });
  });

  afterAll(async () => {
    await app.close();
    await db.automationRule.deleteMany({ where: { workspaceId } });
    await db.contact.deleteMany({ where: { workspaceId } });
    await db.channel.deleteMany({ where: { workspaceId } });
    await db.tag.deleteMany({ where: { workspaceId } });
    await db.$disconnect();
  });

  it("creates the lead conversation, runs the flow once and honours regenerated tokens", async () => {
    const link = await app.inject({ method: "POST", url: `/automations/${ruleId}/webhook` });
    expect(link.statusCode).toBe(200);
    const { token } = link.json() as { token: string };

    const existing = await db.contact.create({ data: { workspaceId, phone: "554799991234", name: "Nome da equipe" } });
    const payload = { nome: "Joana", whatsapp: "(47) 99999-1234", dor: "caixa apertado", enviado_em: "2026-10-11T12:00:00Z" };

    expect((await post(token, payload)).statusCode).toBe(202);
    expect((await post(token, { ...payload, enviado_em: "2026-10-11T12:00:05Z" })).statusCode).toBe(202);

    const runs = await db.automationRun.findMany({ where: { workspaceId, ruleId } });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("completed");

    const contact = await db.contact.findUniqueOrThrow({ where: { id: existing.id } });
    expect(contact.name).toBe("Nome da equipe");
    const conversation = await db.conversation.findFirstOrThrow({ where: { workspaceId, contactId: existing.id, channelId } });
    const messages = await db.message.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: "asc" } });
    expect(messages.map((message) => [message.direction, message.type, message.body])).toEqual([
      ["inbound", "system", "Formulário recebido (Webhook externo)\nNome: Joana\nWhatsapp: (47) 99999-1234\nDor: caixa apertado\nEnviado em: 2026-10-11T12:00:00Z"],
      ["outbound", "text", "Oi Joana, vi aqui teu formulário sobre caixa apertado."]
    ]);
    expect(await db.conversationTag.count({ where: { conversationId: conversation.id } })).toBe(1);
    expect(agentRuntime.activateForMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: messages[0]!.id, instruction: "Agende uma call com Joana." })
    );

    const regenerated = await app.inject({ method: "POST", url: `/automations/${ruleId}/webhook/regenerate` });
    const { token: newToken } = regenerated.json() as { token: string };
    expect(newToken).not.toBe(token);
    expect((await post(token, { whatsapp: "47988887777" })).statusCode).toBe(404);
    expect((await post(newToken, { whatsapp: "47988887777", nome: "Pedro" })).statusCode).toBe(202);
    expect(await db.contact.findFirst({ where: { workspaceId, phone: "554788887777" } })).toMatchObject({ name: "Pedro" });

    await db.automationRule.update({ where: { id: ruleId }, data: { status: "disabled" } });
    expect((await post(newToken, { whatsapp: "47977776666" })).statusCode).toBe(404);
  });
});
