import Fastify from "fastify";
import { realtimeEventSchema, type UserRole } from "@prymeira-talk/shared";
import { describe, expect, it, vi } from "vitest";
import { automationsRoutes } from "./automations.routes.js";
import { createAutomationsService } from "./automations.service.js";
import type { PrismaLike } from "./automations.service.js";

type MockPrisma = {
  automationRule: {
    findMany: any;
    findFirst: any;
    create: any;
    update: any;
    delete: any;
  };
  automationRun: {
    findMany: any;
    upsert: any;
  };
};

type MockPrismaOverrides = {
  automationRule?: Partial<MockPrisma["automationRule"]>;
  automationRun?: Partial<MockPrisma["automationRun"]>;
};

const automationId = "00000000-0000-4000-8000-000000000101";
const runId = "00000000-0000-4000-8000-000000000102";

const baseRule = {
  id: automationId,
  workspaceId: "workspace_a",
  name: "Boas-vindas local",
  status: "enabled" as const,
  trigger: "message.received",
  conditions: { summary: "Quando uma mensagem inbound chegar" },
  actions: [{ type: "send_message", label: "Enviar saudação" }],
  createdAt: new Date("2026-05-21T10:00:00.000Z"),
  updatedAt: new Date("2026-05-21T10:00:00.000Z")
};

const baseRun = {
  id: runId,
  workspaceId: "workspace_a",
  ruleId: automationId,
  eventKey: "message.received:test-event",
  status: "completed",
  input: { source: "test" },
  result: {
    mode: "simulated",
    actionResults: [{ type: "send_message", status: "completed" }]
  },
  createdAt: new Date("2026-05-21T10:05:00.000Z"),
  updatedAt: new Date("2026-05-21T10:05:00.000Z")
};

function createMockPrisma(overrides: MockPrismaOverrides = {}): MockPrisma & PrismaLike {
  return {
    automationRule: {
      findMany:
        overrides.automationRule?.findMany ??
        vi.fn().mockResolvedValue([baseRule]),
      findFirst:
        overrides.automationRule?.findFirst ??
        vi.fn().mockResolvedValue(baseRule),
      create:
        overrides.automationRule?.create ??
        vi.fn().mockResolvedValue(baseRule),
      update:
        overrides.automationRule?.update ??
        vi.fn().mockResolvedValue(baseRule),
      delete:
        overrides.automationRule?.delete ??
        vi.fn().mockResolvedValue(baseRule)
    },
    automationRun: {
      findMany:
        overrides.automationRun?.findMany ??
        vi.fn().mockResolvedValue([baseRun]),
      upsert:
        overrides.automationRun?.upsert ??
        vi.fn().mockResolvedValue(baseRun)
    }
  } as MockPrisma & PrismaLike;
}

async function buildAutomationsApp(input: {
  prisma?: MockPrisma & PrismaLike;
  role?: UserRole;
} = {}) {
  const app = Fastify({ logger: false });
  const prisma = input.prisma ?? createMockPrisma();
  const role = input.role ?? "manager";
  const publish = vi.fn();

  app.decorate("prisma", prisma as never);
  app.decorate("realtime", { publish, addClient: vi.fn(), clientCount: vi.fn() });
  app.addHook("preHandler", async (request) => {
    request.talk = { workspaceId: "workspace_a", role };
  });
  await app.register(automationsRoutes);

  return { app, prisma, publish };
}

describe("automations service", () => {
  it("upserts one completed run for repeated executions of the same trigger event", async () => {
    const storedRuns = new Map<string, typeof baseRun>();
    const prisma = createMockPrisma();
    prisma.automationRun.upsert = vi.fn().mockImplementation(async (args) => {
      const key = [
        args.where.workspaceId_ruleId_eventKey.workspaceId,
        args.where.workspaceId_ruleId_eventKey.ruleId,
        args.where.workspaceId_ruleId_eventKey.eventKey
      ].join(":");
      const existing = storedRuns.get(key);
      const run = {
        ...baseRun,
        ...(existing ?? {}),
        ...args.create,
        ...args.update
      };

      storedRuns.set(key, run);
      return run;
    });
    const service = createAutomationsService(prisma);

    const firstRun = await service.testAutomation({
      workspaceId: "workspace_a",
      automationId,
      eventKey: "message.received:test-event"
    });
    const secondRun = await service.testAutomation({
      workspaceId: "workspace_a",
      automationId,
      eventKey: "message.received:test-event"
    });

    expect(prisma.automationRun.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.automationRun.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          workspaceId_ruleId_eventKey: {
            workspaceId: "workspace_a",
            ruleId: automationId,
            eventKey: "message.received:test-event"
          }
        },
        create: expect.objectContaining({
          workspaceId: "workspace_a",
          ruleId: automationId,
          eventKey: "message.received:test-event",
          status: "completed"
        }),
        update: expect.objectContaining({
          status: "completed"
        })
      })
    );
    expect(firstRun.id).toBe(secondRun.id);
    expect(firstRun.result).toMatchObject({
      mode: "simulated",
      runner: "local",
      actionResults: [
        { type: "send_message", status: "completed" }
      ]
    });
    expect(storedRuns.size).toBe(1);
  });

  it("rejects executions for rules outside the current workspace", async () => {
    const prisma = createMockPrisma({
      automationRule: {
        findMany: vi.fn(),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
        update: vi.fn()
      }
    });
    const service = createAutomationsService(prisma);

    await expect(
      service.testAutomation({
        workspaceId: "workspace_a",
        automationId,
        eventKey: "message.received:test-event"
      })
    ).rejects.toMatchObject({ code: "AUTOMATION_NOT_FOUND" });
    expect(prisma.automationRun.upsert).not.toHaveBeenCalled();
  });

  it("deletes an automation inside the caller workspace", async () => {
    const prisma = createMockPrisma();
    const service = createAutomationsService(prisma);

    const result = await service.deleteAutomation({
      workspaceId: "workspace_a",
      automationId
    });

    expect(result).toEqual({ ok: true, automationId });
    expect(prisma.automationRule.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "workspace_a", id: automationId }
      })
    );
    expect(prisma.automationRule.delete).toHaveBeenCalledWith({
      where: {
        workspaceId_id: {
          workspaceId: "workspace_a",
          id: automationId
        }
      }
    });
  });

  it("rejects enabling an automation with a coming soon flow block", async () => {
    const prisma = createMockPrisma({
      automationRule: {
        findMany: vi.fn(),
        findFirst: vi.fn().mockResolvedValue(baseRule),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue(baseRule)
      }
    });
    const service = createAutomationsService(prisma);

    await expect(
      service.updateAutomation({
        workspaceId: "workspace_a",
        automationId,
        data: {
          status: "enabled",
          actions: {
            version: 1,
            nodes: [
              {
                id: "trigger-1",
                type: "trigger_first_message",
                position: { x: 0, y: 0 },
                data: { title: "Primeira mensagem", config: {} }
              },
              {
                id: "ai-1",
                type: "ai_classify_message",
                position: { x: 240, y: 0 },
                data: { title: "Classificar", config: {} }
              }
            ],
            edges: [{ id: "edge-1", source: "trigger-1", target: "ai-1" }]
          }
        }
      })
    ).rejects.toMatchObject({ code: "AUTOMATION_INVALID_FLOW" });
  });

  it("rejects creating an automation with a malformed graph object", async () => {
    const prisma = createMockPrisma();
    const service = createAutomationsService(prisma);

    await expect(
      service.createAutomation({
        workspaceId: "workspace_a",
        name: "Fluxo quebrado",
        trigger: "message.received",
        actions: {
          version: 1,
          nodes: [],
          edges: [{ id: "edge-1", source: "missing" }]
        }
      })
    ).rejects.toMatchObject({ code: "AUTOMATION_INVALID_FLOW" });
    expect(prisma.automationRule.create).not.toHaveBeenCalled();
  });

  it("simulates graph nodes in manual test runs", async () => {
    const rule = {
      ...baseRule,
      actions: {
        version: 1,
        nodes: [
          {
            id: "trigger-1",
            type: "trigger_first_message",
            position: { x: 0, y: 0 },
            data: { title: "Primeira mensagem", config: {} }
          },
          {
            id: "message-1",
            type: "send_message",
            position: { x: 260, y: 0 },
            data: { title: "Enviar mensagem", config: { text: "Olá!" } }
          }
        ],
        edges: [{ id: "edge-1", source: "trigger-1", target: "message-1" }]
      }
    };
    const prisma = createMockPrisma({
      automationRule: {
        findMany: vi.fn(),
        findFirst: vi.fn().mockResolvedValue(rule),
        create: vi.fn(),
        update: vi.fn()
      },
      automationRun: {
        findMany: vi.fn(),
        upsert: vi.fn().mockImplementation(async (args) => ({
          id: "run-1",
          workspaceId: "workspace_a",
          ruleId: automationId,
          eventKey: args.create.eventKey,
          status: args.create.status,
          input: args.create.input,
          result: args.create.result,
          createdAt: new Date("2026-05-24T12:00:00.000Z"),
          updatedAt: new Date("2026-05-24T12:00:00.000Z")
        }))
      }
    });
    const service = createAutomationsService(prisma);

    const run = await service.testAutomation({
      workspaceId: "workspace_a",
      automationId
    });

    expect(run.result).toMatchObject({
      mode: "simulated",
      runner: "graph",
      actionResults: [
        { nodeId: "trigger-1", type: "trigger_first_message", status: "completed" },
        { nodeId: "message-1", type: "send_message", status: "completed" }
      ]
    });
  });
});

describe("automations routes", () => {
  it("creates a completed simulated run from POST /automations/:automationId/test", async () => {
    const { app, publish } = await buildAutomationsApp({ role: "manager" });

    try {
      const response = await app.inject({
        method: "POST",
        url: `/automations/${automationId}/test`,
        payload: {
          eventKey: "message.received:test-event",
          input: { body: "Oi" }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          id: runId,
          workspaceId: "workspace_a",
          ruleId: automationId,
          eventKey: "message.received:test-event",
          status: "completed",
          result: expect.objectContaining({
            mode: "simulated",
            actionResults: expect.any(Array)
          })
        })
      );
      expect(realtimeEventSchema.parse(publish.mock.calls[0]?.[0])).toEqual({
        type: "automation_run.created",
        workspaceId: "workspace_a",
        payload: response.json()
      });
    } finally {
      await app.close();
    }
  });

  it.each([
    {
      method: "POST" as const,
      url: "/automations",
      payload: {
        name: "Boas-vindas local",
        trigger: "message.received",
        actions: [{ type: "send_message", label: "Enviar saudação" }]
      }
    },
    {
      method: "PATCH" as const,
      url: `/automations/${automationId}`,
      payload: { status: "enabled" }
    },
    {
      method: "POST" as const,
      url: `/automations/${automationId}/test`,
      payload: { eventKey: "message.received:test-event" }
    },
    {
      method: "DELETE" as const,
      url: `/automations/${automationId}`
    }
  ])("returns 403 for agents on $method $url", async ({ method, url, payload }) => {
    const { app, prisma } = await buildAutomationsApp({ role: "agent" });

    try {
      const response = await app.inject({
        method,
        url,
        payload
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        code: "AUTOMATION_MANAGE_FORBIDDEN",
        error: "Automation management permission required."
      });
      expect(prisma.automationRule.create).not.toHaveBeenCalled();
      expect(prisma.automationRule.update).not.toHaveBeenCalled();
      expect(prisma.automationRule.delete).not.toHaveBeenCalled();
      expect(prisma.automationRun.upsert).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each(["manager", "owner"] as const)(
    "allows %s to create, update, and test automations",
    async (role) => {
      const { app } = await buildAutomationsApp({ role });

      try {
        const createResponse = await app.inject({
          method: "POST",
          url: "/automations",
          payload: {
            name: "Boas-vindas local",
            trigger: "message.received",
            actions: [{ type: "send_message", label: "Enviar saudação" }]
          }
        });
        const patchResponse = await app.inject({
          method: "PATCH",
          url: `/automations/${automationId}`,
          payload: { status: "enabled" }
        });
        const testResponse = await app.inject({
          method: "POST",
          url: `/automations/${automationId}/test`,
          payload: { eventKey: "message.received:test-event" }
        });
        const deleteResponse = await app.inject({
          method: "DELETE",
          url: `/automations/${automationId}`
        });

        expect(createResponse.statusCode).toBe(201);
        expect(patchResponse.statusCode).toBe(200);
        expect(testResponse.statusCode).toBe(200);
        expect(deleteResponse.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    }
  );
});
