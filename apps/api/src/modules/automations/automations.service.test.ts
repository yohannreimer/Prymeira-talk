import Fastify from "fastify";
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
  };
  automationRun: {
    findMany: any;
    upsert: any;
  };
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
  actions: [{ type: "send_message", label: "Enviar saudacao" }],
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

function createMockPrisma(overrides: Partial<MockPrisma> = {}): MockPrisma & PrismaLike {
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

async function buildAutomationsApp(prisma = createMockPrisma()) {
  const app = Fastify({ logger: false });

  app.decorate("prisma", prisma as never);
  app.addHook("preHandler", async (request) => {
    request.talk = { workspaceId: "workspace_a", role: "agent" };
  });
  await app.register(automationsRoutes);

  return { app, prisma };
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
});

describe("automations routes", () => {
  it("creates a completed simulated run from POST /automations/:automationId/test", async () => {
    const { app } = await buildAutomationsApp();

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
    } finally {
      await app.close();
    }
  });
});
