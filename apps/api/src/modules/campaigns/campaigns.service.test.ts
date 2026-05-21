import Fastify from "fastify";
import type { UserRole } from "@prymeira-talk/shared";
import { describe, expect, it, vi } from "vitest";
import { campaignsRoutes } from "./campaigns.routes.js";
import { createCampaignsService } from "./campaigns.service.js";
import type { PrismaLike } from "./campaigns.service.js";

type MockPrisma = {
  campaign: {
    findMany: any;
    findFirst: any;
    create: any;
    update: any;
  };
  campaignRecipient: {
    findMany: any;
    upsert: any;
  };
  contactBoard: {
    findFirst: any;
  };
  contactBoardMembership: {
    findMany: any;
  };
};

const campaignId = "00000000-0000-4000-8000-000000000201";
const boardId = "00000000-0000-4000-8000-000000000202";
const firstContactId = "00000000-0000-4000-8000-000000000203";
const secondContactId = "00000000-0000-4000-8000-000000000204";

const baseCampaign = {
  id: campaignId,
  workspaceId: "workspace_a",
  name: "Reativacao VIP",
  status: "draft" as const,
  audience: { type: "board", boardId },
  messageBody: "Oi {{name}}, temos uma novidade para voce.",
  scheduledAt: null,
  mode: "simulated" as const,
  createdAt: new Date("2026-05-21T12:00:00.000Z"),
  updatedAt: new Date("2026-05-21T12:00:00.000Z")
};

const baseRecipients = [
  {
    id: "00000000-0000-4000-8000-000000000205",
    workspaceId: "workspace_a",
    campaignId,
    contactId: firstContactId,
    status: "sent_simulated",
    result: {
      mode: "simulated",
      result: "sent_simulated",
      messagePreview: "Oi Ana, temos uma novidade para voce."
    },
    createdAt: new Date("2026-05-21T12:01:00.000Z"),
    updatedAt: new Date("2026-05-21T12:01:00.000Z"),
    contact: {
      id: firstContactId,
      workspaceId: "workspace_a",
      name: "Ana",
      phone: "+5511999990001",
      email: null,
      company: null
    }
  },
  {
    id: "00000000-0000-4000-8000-000000000206",
    workspaceId: "workspace_a",
    campaignId,
    contactId: secondContactId,
    status: "sent_simulated",
    result: {
      mode: "simulated",
      result: "sent_simulated",
      messagePreview: "Oi Bruno, temos uma novidade para voce."
    },
    createdAt: new Date("2026-05-21T12:01:00.000Z"),
    updatedAt: new Date("2026-05-21T12:01:00.000Z"),
    contact: {
      id: secondContactId,
      workspaceId: "workspace_a",
      name: "Bruno",
      phone: "+5511999990002",
      email: null,
      company: null
    }
  }
];

function createMockPrisma(overrides: Partial<MockPrisma> = {}): MockPrisma & PrismaLike {
  return {
    campaign: {
      findMany: overrides.campaign?.findMany ?? vi.fn().mockResolvedValue([baseCampaign]),
      findFirst: overrides.campaign?.findFirst ?? vi.fn().mockResolvedValue(baseCampaign),
      create: overrides.campaign?.create ?? vi.fn().mockResolvedValue(baseCampaign),
      update: overrides.campaign?.update ?? vi.fn().mockResolvedValue(baseCampaign)
    },
    campaignRecipient: {
      findMany:
        overrides.campaignRecipient?.findMany ?? vi.fn().mockResolvedValue(baseRecipients),
      upsert:
        overrides.campaignRecipient?.upsert ??
        vi.fn().mockImplementation(async (args) => ({
          ...baseRecipients.find(
            (recipient) =>
              recipient.contactId === args.where.workspaceId_campaignId_contactId.contactId
          ),
          ...args.create,
          ...args.update
        }))
    },
    contactBoard: {
      findFirst:
        overrides.contactBoard?.findFirst ??
        vi.fn().mockResolvedValue({ id: boardId, workspaceId: "workspace_a" })
    },
    contactBoardMembership: {
      findMany:
        overrides.contactBoardMembership?.findMany ??
        vi.fn().mockResolvedValue([
          {
            contactId: firstContactId,
            contact: {
              id: firstContactId,
              workspaceId: "workspace_a",
              name: "Ana",
              phone: "+5511999990001"
            }
          },
          {
            contactId: secondContactId,
            contact: {
              id: secondContactId,
              workspaceId: "workspace_a",
              name: "Bruno",
              phone: "+5511999990002"
            }
          }
        ])
    }
  } as MockPrisma & PrismaLike;
}

async function buildCampaignsApp(input: {
  prisma?: MockPrisma & PrismaLike;
  role?: UserRole;
} = {}) {
  const app = Fastify({ logger: false });
  const prisma = input.prisma ?? createMockPrisma();
  const role = input.role ?? "manager";

  app.decorate("prisma", prisma as never);
  app.addHook("preHandler", async (request) => {
    request.talk = { workspaceId: "workspace_a", role };
  });
  await app.register(campaignsRoutes);

  return { app, prisma };
}

describe("campaigns service", () => {
  it("creates simulated recipients from a board audience when sending a campaign", async () => {
    const prisma = createMockPrisma();
    const service = createCampaignsService(prisma);

    const result = await service.sendSimulated({
      workspaceId: "workspace_a",
      campaignId
    });

    expect(result).toEqual({
      mode: "simulated",
      result: "sent_simulated",
      recipientsCreated: 2
    });
    expect(prisma.contactBoardMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "workspace_a", boardId }
      })
    );
    expect(prisma.campaignRecipient.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.campaignRecipient.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          workspaceId_campaignId_contactId: {
            workspaceId: "workspace_a",
            campaignId,
            contactId: firstContactId
          }
        },
        create: expect.objectContaining({
          workspaceId: "workspace_a",
          campaignId,
          contactId: firstContactId,
          status: "sent_simulated",
          result: expect.objectContaining({
            mode: "simulated",
            result: "sent_simulated"
          })
        })
      })
    );
  });

  it("rejects audience resolution for campaigns outside the current workspace", async () => {
    const prisma = createMockPrisma({
      campaign: {
        findMany: vi.fn(),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
        update: vi.fn()
      }
    });
    const service = createCampaignsService(prisma);

    await expect(
      service.resolveAudience({ workspaceId: "workspace_a", campaignId })
    ).rejects.toMatchObject({ code: "CAMPAIGN_NOT_FOUND" });
    expect(prisma.contactBoardMembership.findMany).not.toHaveBeenCalled();
  });
});

describe("campaigns routes", () => {
  it("sends a simulated campaign from POST /campaigns/:campaignId/send-simulated", async () => {
    const { app } = await buildCampaignsApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: `/campaigns/${campaignId}/send-simulated`
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        mode: "simulated",
        result: "sent_simulated",
        recipientsCreated: 2
      });
    } finally {
      await app.close();
    }
  });

  it.each([
    {
      method: "POST" as const,
      url: "/campaigns",
      payload: {
        name: "Reativacao VIP",
        audience: { type: "board", boardId },
        messageBody: "Oi {{name}}"
      }
    },
    {
      method: "PATCH" as const,
      url: `/campaigns/${campaignId}`,
      payload: { status: "scheduled" }
    },
    {
      method: "POST" as const,
      url: `/campaigns/${campaignId}/send-simulated`,
      payload: {}
    }
  ])("returns 403 for agents on $method $url", async ({ method, url, payload }) => {
    const { app, prisma } = await buildCampaignsApp({ role: "agent" });

    try {
      const response = await app.inject({ method, url, payload });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        code: "CAMPAIGN_MANAGE_FORBIDDEN",
        error: "Campaign management permission required."
      });
      expect(prisma.campaign.create).not.toHaveBeenCalled();
      expect(prisma.campaign.update).not.toHaveBeenCalled();
      expect(prisma.campaignRecipient.upsert).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
