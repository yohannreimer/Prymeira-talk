import Fastify from "fastify";
import type { UserRole } from "@prymeira-talk/shared";
import { describe, expect, it, vi } from "vitest";
import { crmRoutes } from "./crm.routes.js";
import { createCrmService } from "./crm.service.js";
import type { PrismaLike } from "./crm.service.js";

type MockPrisma = {
  contact: {
    findUnique: any;
  };
  crmSyncAction: {
    create: any;
    findMany: any;
  };
};

const actionId = "00000000-0000-4000-8000-000000000501";
const contactId = "00000000-0000-4000-8000-000000000502";

const baseAction = {
  id: actionId,
  workspaceId: "workspace_a",
  contactId,
  actionType: "link_contact",
  mode: "simulated" as const,
  status: "completed",
  payload: { atomicCrmContactId: "crm_123" },
  result: { mode: "simulated", linked: true },
  createdAt: new Date("2026-05-21T15:00:00.000Z"),
  updatedAt: new Date("2026-05-21T15:00:00.000Z")
};

function createMockPrisma(overrides: Partial<MockPrisma> = {}): MockPrisma & PrismaLike {
  return {
    contact: {
      findUnique:
        overrides.contact?.findUnique ??
        vi.fn().mockResolvedValue({ id: contactId, workspaceId: "workspace_a" })
    },
    crmSyncAction: {
      create:
        overrides.crmSyncAction?.create ??
        vi.fn().mockImplementation(async (args) => ({
          ...baseAction,
          ...args.data
        })),
      findMany: overrides.crmSyncAction?.findMany ?? vi.fn().mockResolvedValue([baseAction])
    }
  } as MockPrisma & PrismaLike;
}

async function buildCrmApp(input: {
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
  await app.register(crmRoutes);

  return { app, prisma };
}

describe("crm service", () => {
  it("creates a simulated link contact action", async () => {
    const prisma = createMockPrisma();
    const service = createCrmService(prisma);

    const action = await service.linkContact({
      workspaceId: "workspace_a",
      contactId,
      atomicCrmContactId: "crm_123"
    });

    expect(action).toEqual(
      expect.objectContaining({
        workspaceId: "workspace_a",
        contactId,
        actionType: "link_contact",
        mode: "simulated",
        status: "completed",
        result: expect.objectContaining({
          mode: "simulated",
          linked: true
        })
      })
    );
    expect(prisma.contact.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId_id: {
            workspaceId: "workspace_a",
            id: contactId
          }
        }
      })
    );
  });

  it("creates a simulated lead action", async () => {
    const prisma = createMockPrisma();
    const service = createCrmService(prisma);

    const action = await service.createLead({
      workspaceId: "workspace_a",
      contactId,
      title: "Novo lead Talk"
    });

    expect(action).toEqual(
      expect.objectContaining({
        actionType: "create_lead",
        mode: "simulated",
        result: expect.objectContaining({
          mode: "simulated",
          leadCreated: true
        })
      })
    );
  });

  it("lists sync actions by contact within the current workspace", async () => {
    const prisma = createMockPrisma();
    const service = createCrmService(prisma);

    const actions = await service.listSyncActions({
      workspaceId: "workspace_a",
      contactId
    });

    expect(actions).toHaveLength(1);
    expect(prisma.crmSyncAction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId: "workspace_a",
          contactId
        }
      })
    );
  });

  it("rejects simulated actions for contacts outside the current workspace", async () => {
    const prisma = createMockPrisma({
      contact: {
        findUnique: vi.fn().mockResolvedValue(null)
      }
    });
    const service = createCrmService(prisma);

    await expect(
      service.createLead({
        workspaceId: "workspace_a",
        contactId,
        title: "Novo lead Talk"
      })
    ).rejects.toMatchObject({ code: "CRM_CONTACT_NOT_FOUND" });
    expect(prisma.crmSyncAction.create).not.toHaveBeenCalled();
  });
});

describe("crm routes", () => {
  it("creates a simulated lead from POST /crm/create-lead", async () => {
    const { app } = await buildCrmApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/crm/create-lead",
        payload: {
          contactId,
          title: "Novo lead Talk"
        }
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual(
        expect.objectContaining({
          actionType: "create_lead",
          mode: "simulated",
          status: "completed"
        })
      );
    } finally {
      await app.close();
    }
  });

  it("rejects CRM mutations when caller is an agent", async () => {
    const { app, prisma } = await buildCrmApp({ role: "agent" });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/crm/create-lead",
        payload: {
          contactId,
          title: "Novo lead Talk"
        }
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        code: "CRM_MANAGE_FORBIDDEN",
        error: "CRM management permission required."
      });
      expect(prisma.crmSyncAction.create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 404 when CRM mutation references a contact outside workspace", async () => {
    const prisma = createMockPrisma({
      contact: {
        findUnique: vi.fn().mockResolvedValue(null)
      }
    });
    const { app } = await buildCrmApp({ prisma });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/crm/create-lead",
        payload: {
          contactId,
          title: "Novo lead Talk"
        }
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        code: "CRM_CONTACT_NOT_FOUND",
        error: "CRM contact not found."
      });
      expect(prisma.crmSyncAction.create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
