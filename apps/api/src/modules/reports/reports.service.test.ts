import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { reportsRoutes } from "./reports.routes.js";
import { createReportsService } from "./reports.service.js";
import type { PrismaLike } from "./reports.service.js";

type MockPrisma = {
  conversation: {
    count: any;
    groupBy: any;
    findMany: any;
  };
  message: {
    count: any;
    groupBy: any;
    findMany: any;
  };
  campaignRecipient: {
    count: any;
    groupBy: any;
  };
  automationRun: {
    count: any;
    groupBy: any;
  };
};

const workspaceId = "workspace_a";

function createMockPrisma(overrides: Partial<MockPrisma> = {}): MockPrisma & PrismaLike {
  return {
    conversation: {
      count: overrides.conversation?.count ?? vi.fn().mockResolvedValue(4),
      groupBy:
        overrides.conversation?.groupBy ??
        vi.fn().mockResolvedValue([
          { status: "open", _count: { _all: 2 } },
          { status: "pending", _count: { _all: 1 } },
          { status: "closed", _count: { _all: 1 } }
        ]),
      findMany:
        overrides.conversation?.findMany ??
        vi.fn().mockResolvedValue([
          {
            id: "conversation_1",
            status: "open",
            createdAt: new Date("2026-05-20T10:00:00.000Z"),
            department: { name: "Vendas" },
            channel: {
              id: "00000000-0000-4000-8000-000000000101",
              displayName: "WhatsApp matriz",
              providerKey: "matriz"
            },
            tags: [{ tag: { name: "VIP", color: "#24564a" } }]
          },
          {
            id: "conversation_2",
            status: "closed",
            createdAt: new Date("2026-05-21T11:00:00.000Z"),
            department: null,
            channel: {
              id: "00000000-0000-4000-8000-000000000102",
              displayName: null,
              providerKey: "suporte"
            },
            tags: []
          }
        ])
    },
    message: {
      count: overrides.message?.count ?? vi.fn().mockResolvedValue(5),
      groupBy:
        overrides.message?.groupBy ??
        vi.fn().mockResolvedValue([
          { direction: "inbound", _count: { _all: 3 } },
          { direction: "outbound", _count: { _all: 2 } }
        ]),
      findMany:
        overrides.message?.findMany ??
        vi.fn().mockResolvedValue([
          { createdAt: new Date("2026-05-20T10:05:00.000Z"), direction: "inbound" },
          { createdAt: new Date("2026-05-21T11:05:00.000Z"), direction: "outbound" }
        ])
    },
    campaignRecipient: {
      count: overrides.campaignRecipient?.count ?? vi.fn().mockResolvedValue(3),
      groupBy:
        overrides.campaignRecipient?.groupBy ??
        vi.fn().mockResolvedValue([
          { status: "sent_simulated", _count: { _all: 2 } },
          { status: "failed", _count: { _all: 1 } }
        ])
    },
    automationRun: {
      count: overrides.automationRun?.count ?? vi.fn().mockResolvedValue(2),
      groupBy:
        overrides.automationRun?.groupBy ??
        vi.fn().mockResolvedValue([{ status: "completed", _count: { _all: 2 } }])
    }
  } as MockPrisma & PrismaLike;
}

async function buildReportsApp(prisma: MockPrisma & PrismaLike = createMockPrisma()) {
  const app = Fastify({ logger: false });

  app.decorate("prisma", prisma as never);
  app.addHook("preHandler", async (request) => {
    request.talk = { workspaceId, role: "manager" };
  });
  await app.register(reportsRoutes);

  return { app, prisma };
}

describe("reports service", () => {
  it("aggregates overview metrics and breakdowns for the current workspace", async () => {
    const prisma = createMockPrisma();
    const service = createReportsService(prisma);

    const overview = await service.getOverview({ workspaceId });

    expect(overview.cards).toEqual([
      { key: "conversations", label: "Conversas", value: 4, helper: "2 abertas" },
      { key: "messages", label: "Mensagens", value: 5, helper: "3 inbound" },
      { key: "campaignRecipients", label: "Disparos", value: 3, helper: "2 sent_simulated" },
      { key: "automationRuns", label: "Automacoes", value: 2, helper: "2 completed" }
    ]);
    expect(overview.conversationsByStatus).toEqual([
      { key: "open", label: "Abertas", value: 2 },
      { key: "pending", label: "Pendentes", value: 1 },
      { key: "closed", label: "Fechadas", value: 1 }
    ]);
    expect(overview.messagesByDirection).toEqual([
      { key: "inbound", label: "Inbound", value: 3 },
      { key: "outbound", label: "Outbound", value: 2 }
    ]);
    expect(overview.campaignResults).toEqual([
      { key: "sent_simulated", label: "sent_simulated", value: 2 },
      { key: "failed", label: "failed", value: 1 }
    ]);
    expect(overview.automationRuns).toEqual([
      { key: "completed", label: "completed", value: 2 }
    ]);
    expect(overview.breakdowns.departments).toEqual([
      { key: "Vendas", label: "Vendas", value: 1 },
      { key: "unassigned", label: "Sem departamento", value: 1 }
    ]);
    expect(overview.breakdowns.channels).toEqual([
      {
        key: "00000000-0000-4000-8000-000000000101",
        label: "WhatsApp matriz",
        value: 1
      },
      { key: "00000000-0000-4000-8000-000000000102", label: "suporte", value: 1 }
    ]);
    expect(overview.breakdowns.tags).toEqual([{ key: "VIP", label: "VIP", value: 1 }]);
    expect(overview.timeSeries).toEqual([
      {
        date: "2026-05-20",
        conversations: 1,
        inboundMessages: 1,
        outboundMessages: 0
      },
      {
        date: "2026-05-21",
        conversations: 1,
        inboundMessages: 0,
        outboundMessages: 1
      }
    ]);
    expect(prisma.conversation.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId } })
    );
    expect(prisma.message.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId } })
    );
    expect(prisma.campaignRecipient.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId } })
    );
    expect(prisma.automationRun.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId } })
    );
  });

  it("keeps channels with duplicated labels as separate breakdown rows", async () => {
    const firstChannelId = "00000000-0000-4000-8000-000000000301";
    const secondChannelId = "00000000-0000-4000-8000-000000000302";
    const prisma = createMockPrisma({
      conversation: {
        count: vi.fn().mockResolvedValue(2),
        groupBy: vi.fn().mockResolvedValue([{ status: "open", _count: { _all: 2 } }]),
        findMany: vi.fn().mockResolvedValue([
          {
            id: "conversation_1",
            status: "open",
            createdAt: new Date("2026-05-20T10:00:00.000Z"),
            department: null,
            channel: {
              id: firstChannelId,
              displayName: "Comercial",
              providerKey: "comercial-1"
            },
            tags: []
          },
          {
            id: "conversation_2",
            status: "open",
            createdAt: new Date("2026-05-20T11:00:00.000Z"),
            department: null,
            channel: {
              id: secondChannelId,
              displayName: "Comercial",
              providerKey: "comercial-2"
            },
            tags: []
          }
        ])
      }
    });
    const service = createReportsService(prisma);

    const overview = await service.getOverview({ workspaceId });

    expect(overview.breakdowns.channels).toEqual([
      { key: firstChannelId, label: "Comercial", value: 1 },
      { key: secondChannelId, label: "Comercial", value: 1 }
    ]);
  });
});

describe("reports routes", () => {
  it("returns overview data from GET /reports/overview", async () => {
    const { app } = await buildReportsApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/reports/overview"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          cards: expect.any(Array),
          conversationsByStatus: expect.any(Array),
          messagesByDirection: expect.any(Array),
          campaignResults: expect.any(Array),
          automationRuns: expect.any(Array),
          timeSeries: expect.any(Array),
          breakdowns: expect.objectContaining({
            departments: expect.any(Array),
            tags: expect.any(Array),
            channels: expect.any(Array)
          })
        })
      );
    } finally {
      await app.close();
    }
  });
});
