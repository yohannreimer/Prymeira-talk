import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { describe, expect, it, vi } from "vitest";
import { automationWebhookRoutes } from "./automation-webhook.routes.js";
import {
  AutomationWebhookServiceError,
  type AutomationWebhookService
} from "./automation-webhook.service.js";

const token = "t".repeat(43);
const ruleId = "00000000-0000-4000-8000-000000000101";
const rule = { id: ruleId, workspaceId: "workspace_a", status: "enabled" };

function createService(overrides: Partial<Record<keyof AutomationWebhookService, unknown>> = {}) {
  return {
    resolveToken: vi.fn().mockImplementation(async (value: string) => (value === token ? rule : null)),
    claimSubmission: vi.fn().mockResolvedValue({ claimed: true, eventKey: "webhook.received:abc:1" }),
    processSubmission: vi.fn().mockResolvedValue({ id: "run-1" }),
    getOrCreateWebhook: vi.fn().mockResolvedValue({
      automationId: ruleId,
      token,
      path: `/webhooks/automations/${token}`,
      createdAt: "2026-10-11T12:00:00.000Z",
      updatedAt: "2026-10-11T12:00:00.000Z"
    }),
    regenerateWebhook: vi.fn(),
    ...overrides
  };
}

async function buildRoutesApp(
  service = createService(),
  options: { role?: "owner" | "manager" | "agent"; withRateLimit?: boolean } = {}
) {
  const app = Fastify({ logger: false });
  const tasks: Array<() => Promise<unknown>> = [];

  if (options.withRateLimit) {
    await app.register(rateLimit, { global: true, max: 1000, timeWindow: "1 minute" });
  }

  app.decorateRequest("talk");
  app.addHook("onRequest", async (request) => {
    request.talk = { workspaceId: "workspace_a", role: options.role ?? "owner" };
  });
  await app.register(automationWebhookRoutes, {
    service: service as unknown as AutomationWebhookService,
    schedule: (task) => {
      tasks.push(task);
    }
  });

  return { app, service, tasks };
}

describe("automation webhook routes", () => {
  it("answers 202 right away and processes the submission afterwards", async () => {
    const { app, service, tasks } = await buildRoutesApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: `/webhooks/automations/${token}`,
        payload: { nome: "Joana", whatsapp: "(47) 99999-1234" }
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ ok: true });
      expect(service.claimSubmission).toHaveBeenCalledWith({
        rule,
        submission: expect.objectContaining({ phone: "5547999991234", name: "Joana" })
      });
      expect(service.processSubmission).not.toHaveBeenCalled();
      expect(tasks).toHaveLength(1);

      await tasks[0]!();
      expect(service.processSubmission).toHaveBeenCalledWith({
        rule,
        eventKey: "webhook.received:abc:1",
        submission: expect.objectContaining({ phone: "5547999991234" })
      });
    } finally {
      await app.close();
    }
  });

  it("accepts JSON sent as text/plain by simple browser requests", async () => {
    const { app, tasks } = await buildRoutesApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: `/webhooks/automations/${token}`,
        headers: { "content-type": "text/plain" },
        payload: JSON.stringify({ telefone: "47999991234" })
      });

      expect(response.statusCode).toBe(202);
      expect(tasks).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("returns a bare 404 for unknown, regenerated or disabled tokens", async () => {
    const { app, service, tasks } = await buildRoutesApp();

    try {
      for (const url of [`/webhooks/automations/${"x".repeat(43)}`, "/webhooks/automations/short"]) {
        const response = await app.inject({ method: "POST", url, payload: { whatsapp: "47999991234" } });

        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ ok: false, error: "not_found" });
      }
      expect(service.claimSubmission).not.toHaveBeenCalled();
      expect(tasks).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("rejects invalid phones with 422 and non-object bodies with 400", async () => {
    const { app, service } = await buildRoutesApp();

    try {
      const invalidPhone = await app.inject({
        method: "POST",
        url: `/webhooks/automations/${token}`,
        payload: { nome: "Joana", whatsapp: "123" }
      });
      const invalidBody = await app.inject({
        method: "POST",
        url: `/webhooks/automations/${token}`,
        payload: [{ whatsapp: "47999991234" }]
      });

      expect(invalidPhone.statusCode).toBe(422);
      expect(invalidPhone.json()).toMatchObject({ error: "invalid_phone" });
      expect(invalidBody.statusCode).toBe(400);
      expect(service.claimSubmission).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("acknowledges duplicates without starting another run", async () => {
    const service = createService({ claimSubmission: vi.fn().mockResolvedValue({ claimed: false }) });
    const { app, tasks } = await buildRoutesApp(service);

    try {
      const response = await app.inject({
        method: "POST",
        url: `/webhooks/automations/${token}`,
        payload: { whatsapp: "47999991234" }
      });

      expect(response.statusCode).toBe(202);
      expect(tasks).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("limits the body size", async () => {
    const { app, service } = await buildRoutesApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: `/webhooks/automations/${token}`,
        payload: { whatsapp: "47999991234", dor: "x".repeat(17 * 1024) }
      });

      expect(response.statusCode).toBe(413);
      expect(service.resolveToken).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rate-limits each token separately", async () => {
    const { app } = await buildRoutesApp(createService(), { withRateLimit: true });

    try {
      const statuses: number[] = [];
      for (let index = 0; index < 31; index += 1) {
        const response = await app.inject({
          method: "POST",
          url: `/webhooks/automations/${token}`,
          payload: { whatsapp: "47999991234", tentativa: index }
        });
        statuses.push(response.statusCode);
      }
      const otherToken = await app.inject({
        method: "POST",
        url: `/webhooks/automations/${"o".repeat(43)}`,
        payload: { whatsapp: "47999991234" }
      });

      expect(statuses.slice(0, 30).every((status) => status === 202)).toBe(true);
      expect(statuses[30]).toBe(429);
      expect(otherToken.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("lets automation managers get the link and blocks agents", async () => {
    const managed = await buildRoutesApp(createService(), { role: "manager" });
    const agent = await buildRoutesApp(createService(), { role: "agent" });

    try {
      const response = await managed.app.inject({ method: "POST", url: `/automations/${ruleId}/webhook` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ token, path: `/webhooks/automations/${token}` });
      expect(managed.service.getOrCreateWebhook).toHaveBeenCalledWith({
        workspaceId: "workspace_a",
        automationId: ruleId
      });

      const forbidden = await agent.app.inject({ method: "POST", url: `/automations/${ruleId}/webhook/regenerate` });
      expect(forbidden.statusCode).toBe(403);
      expect(agent.service.regenerateWebhook).not.toHaveBeenCalled();
    } finally {
      await managed.app.close();
      await agent.app.close();
    }
  });

  it("maps a missing webhook trigger to 409 and unknown automations to 404", async () => {
    const service = createService({
      getOrCreateWebhook: vi
        .fn()
        .mockRejectedValue(
          new AutomationWebhookServiceError("AUTOMATION_WEBHOOK_TRIGGER_MISSING", "Salve o fluxo.")
        ),
      regenerateWebhook: vi
        .fn()
        .mockRejectedValue(new AutomationWebhookServiceError("AUTOMATION_NOT_FOUND", "Automation rule not found."))
    });
    const { app } = await buildRoutesApp(service);

    try {
      expect((await app.inject({ method: "POST", url: `/automations/${ruleId}/webhook` })).statusCode).toBe(409);
      expect(
        (await app.inject({ method: "POST", url: `/automations/${ruleId}/webhook/regenerate` })).statusCode
      ).toBe(404);
      expect((await app.inject({ method: "POST", url: "/automations/not-a-uuid/webhook" })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
