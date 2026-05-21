import Fastify from "fastify";
import {
  contactBoardMembershipSchema,
  contactBoardSchema,
  contactBoardStageSchema,
  realtimeEventSchema
} from "@prymeira-talk/shared";
import { describe, expect, it, vi } from "vitest";
import { createBoardsService } from "./boards.service.js";
import type { PrismaLike } from "./boards.service.js";
import { boardsRoutes } from "./boards.routes.js";

type MockPrisma = {
  $transaction: PrismaLike["$transaction"] & ReturnType<typeof vi.fn>;
  contactBoard: {
    findMany: ReturnType<typeof vi.fn<PrismaLike["contactBoard"]["findMany"]>>;
    create: ReturnType<typeof vi.fn<PrismaLike["contactBoard"]["create"]>>;
    findFirst: ReturnType<typeof vi.fn<PrismaLike["contactBoard"]["findFirst"]>>;
  };
  contactBoardStage: {
    create: ReturnType<typeof vi.fn<PrismaLike["contactBoardStage"]["create"]>>;
    findFirst: ReturnType<typeof vi.fn<PrismaLike["contactBoardStage"]["findFirst"]>>;
  };
  contactBoardMembership: {
    findMany: ReturnType<typeof vi.fn<PrismaLike["contactBoardMembership"]["findMany"]>>;
    findFirst: ReturnType<typeof vi.fn<PrismaLike["contactBoardMembership"]["findFirst"]>>;
    upsert: ReturnType<typeof vi.fn<PrismaLike["contactBoardMembership"]["upsert"]>>;
    update: ReturnType<typeof vi.fn<PrismaLike["contactBoardMembership"]["update"]>>;
    updateMany: ReturnType<typeof vi.fn<PrismaLike["contactBoardMembership"]["updateMany"]>>;
  };
  contact: {
    findUnique: ReturnType<typeof vi.fn<PrismaLike["contact"]["findUnique"]>>;
  };
};

const boardId = "00000000-0000-4000-8000-000000000010";
const otherBoardId = "00000000-0000-4000-8000-000000000011";
const stageId = "00000000-0000-4000-8000-000000000020";
const nextStageId = "00000000-0000-4000-8000-000000000021";
const contactId = "00000000-0000-4000-8000-000000000030";
const membershipId = "00000000-0000-4000-8000-000000000040";

const baseBoard = {
  id: boardId,
  workspaceId: "workspace_a",
  name: "Pre-vendas",
  description: "Pipeline comercial",
  createdAt: new Date("2026-05-20T10:00:00.000Z"),
  updatedAt: new Date("2026-05-20T10:00:00.000Z")
};

const baseStages = [
  {
    id: stageId,
    workspaceId: "workspace_a",
    boardId,
    name: "Novo",
    color: "#24564a",
    order: 0,
    createdAt: new Date("2026-05-20T10:00:00.000Z"),
    updatedAt: new Date("2026-05-20T10:00:00.000Z")
  },
  {
    id: nextStageId,
    workspaceId: "workspace_a",
    boardId,
    name: "Qualificado",
    color: "#d29b44",
    order: 1,
    createdAt: new Date("2026-05-20T10:00:00.000Z"),
    updatedAt: new Date("2026-05-20T10:00:00.000Z")
  }
];

const baseContact = {
  id: contactId,
  workspaceId: "workspace_a",
  name: "Ana Silva",
  phone: "+5511999990000",
  email: "ana@example.com",
  company: "Prymeira",
  avatarUrl: null,
  customFields: {},
  atomicCrmContactId: null,
  atomicCrmLeadId: null,
  createdAt: new Date("2026-05-20T12:00:00.000Z"),
  updatedAt: new Date("2026-05-20T12:30:00.000Z")
};

const baseMembership = {
  id: membershipId,
  workspaceId: "workspace_a",
  contactId,
  boardId,
  stageId,
  isPrimary: true,
  createdAt: new Date("2026-05-20T12:45:00.000Z"),
  updatedAt: new Date("2026-05-20T12:45:00.000Z"),
  contact: baseContact
};

function createMockPrisma(overrides: Partial<MockPrisma> = {}): MockPrisma & PrismaLike {
  let prisma: MockPrisma & PrismaLike;
  const transaction = vi.fn(
    <T,>(callback: Parameters<PrismaLike["$transaction"]>[0]) => callback(prisma)
  ) as PrismaLike["$transaction"] & ReturnType<typeof vi.fn>;

  prisma = {
    $transaction:
      overrides.$transaction ??
      transaction,
    contactBoard: {
      findMany:
        overrides.contactBoard?.findMany ??
        vi.fn<PrismaLike["contactBoard"]["findMany"]>().mockResolvedValue([
          {
            ...baseBoard,
            stages: [baseStages[1], baseStages[0]]
          }
        ]),
      create:
        overrides.contactBoard?.create ??
        vi.fn<PrismaLike["contactBoard"]["create"]>().mockResolvedValue(baseBoard),
      findFirst:
        overrides.contactBoard?.findFirst ??
        vi.fn<PrismaLike["contactBoard"]["findFirst"]>().mockResolvedValue({
          ...baseBoard,
          stages: baseStages
        })
    },
    contactBoardStage: {
      create:
        overrides.contactBoardStage?.create ??
        vi.fn<PrismaLike["contactBoardStage"]["create"]>().mockResolvedValue(baseStages[0]),
      findFirst:
        overrides.contactBoardStage?.findFirst ??
        vi.fn<PrismaLike["contactBoardStage"]["findFirst"]>().mockResolvedValue(baseStages[0])
    },
    contactBoardMembership: {
      findMany:
        overrides.contactBoardMembership?.findMany ??
        vi.fn<PrismaLike["contactBoardMembership"]["findMany"]>().mockResolvedValue([
          baseMembership
        ]),
      findFirst:
        overrides.contactBoardMembership?.findFirst ??
        vi.fn<PrismaLike["contactBoardMembership"]["findFirst"]>().mockResolvedValue(
          baseMembership
        ),
      upsert:
        overrides.contactBoardMembership?.upsert ??
        vi.fn<PrismaLike["contactBoardMembership"]["upsert"]>().mockResolvedValue(
          baseMembership
        ),
      update:
        overrides.contactBoardMembership?.update ??
        vi.fn<PrismaLike["contactBoardMembership"]["update"]>().mockResolvedValue({
          ...baseMembership,
          stageId: nextStageId
        }),
      updateMany:
        overrides.contactBoardMembership?.updateMany ??
        vi.fn<PrismaLike["contactBoardMembership"]["updateMany"]>().mockResolvedValue({
          count: 1
        })
    },
    contact: {
      findUnique:
        overrides.contact?.findUnique ??
        vi.fn<PrismaLike["contact"]["findUnique"]>().mockResolvedValue({
          id: contactId
        })
    }
  } as MockPrisma & PrismaLike;

  return prisma;
}

async function buildBoardsApp(prisma = createMockPrisma()) {
  const app = Fastify({ logger: false });
  const publish = vi.fn();

  app.decorate("prisma", prisma as never);
  app.decorate("realtime", { publish, addClient: vi.fn(), clientCount: vi.fn() });
  app.addHook("preHandler", async (request) => {
    request.talk = { workspaceId: "workspace_a", role: "agent" };
  });
  await app.register(boardsRoutes);

  return { app, prisma, publish };
}

const aggregateBoardSchema = contactBoardSchema.extend({
  stages: contactBoardStageSchema.array()
});

describe("boards service", () => {
  it("lists boards inside a workspace with stages ordered by sort order", async () => {
    const prisma = createMockPrisma();
    const service = createBoardsService(prisma);

    const boards = await service.listBoards({ workspaceId: "workspace_a" });

    expect(prisma.contactBoard.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace_a" },
      include: {
        stages: {
          orderBy: { order: "asc" }
        }
      },
      orderBy: { createdAt: "asc" }
    });
    expect(boards[0]?.stages.map((stage) => stage.name)).toEqual([
      "Qualificado",
      "Novo"
    ]);
  });

  it("lists board contacts for one workspace board with contact cards", async () => {
    const prisma = createMockPrisma();
    const service = createBoardsService(prisma);

    const result = await service.listBoardContacts({
      workspaceId: "workspace_a",
      boardId
    });

    expect(prisma.contactBoard.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: "workspace_a", id: boardId },
      include: {
        stages: {
          orderBy: { order: "asc" }
        }
      }
    });
    expect(prisma.contactBoardMembership.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace_a", boardId },
      include: { contact: true },
      orderBy: [{ updatedAt: "desc" }]
    });
    expect(result.memberships[0]?.contact.name).toBe("Ana Silva");
  });

  it("validates stage ownership and updates primary state inside one transaction when adding a primary contact", async () => {
    const prisma = createMockPrisma();
    const service = createBoardsService(prisma);

    await service.addContactToBoard({
      workspaceId: "workspace_a",
      boardId,
      stageId,
      contactId,
      isPrimary: true
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.contactBoardStage.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: "workspace_a", boardId, id: stageId }
    });
    expect(prisma.contact.findUnique).toHaveBeenCalledWith({
      where: {
        workspaceId_id: {
          workspaceId: "workspace_a",
          id: contactId
        }
      },
      select: { id: true }
    });
    expect(prisma.contactBoardMembership.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace_a", contactId, isPrimary: true },
      data: { isPrimary: false }
    });
    expect(prisma.contactBoardMembership.upsert).toHaveBeenCalledWith({
      where: {
        workspaceId_contactId_boardId: {
          workspaceId: "workspace_a",
          contactId,
          boardId
        }
      },
      create: {
        workspaceId: "workspace_a",
        contactId,
        boardId,
        stageId,
        isPrimary: true
      },
      update: {
        stageId,
        isPrimary: true
      },
      include: { contact: true }
    });
  });

  it("updates primary state inside one transaction when moving and making a membership primary", async () => {
    const prisma = createMockPrisma();
    const service = createBoardsService(prisma);

    await service.moveContactToStage({
      workspaceId: "workspace_a",
      membershipId,
      stageId: nextStageId,
      isPrimary: true
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.contactBoardMembership.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace_a", contactId, isPrimary: true },
      data: { isPrimary: false }
    });
    expect(prisma.contactBoardMembership.update).toHaveBeenCalledWith({
      where: {
        workspaceId_id: {
          workspaceId: "workspace_a",
          id: membershipId
        }
      },
      data: { stageId: nextStageId, isPrimary: true },
      include: { contact: true }
    });
  });

  it("rejects adding a contact when the stage does not belong to the board", async () => {
    const prisma = createMockPrisma({
      contactBoardStage: {
        ...createMockPrisma().contactBoardStage,
        findFirst: vi
          .fn<PrismaLike["contactBoardStage"]["findFirst"]>()
          .mockResolvedValue(null)
      }
    });
    const service = createBoardsService(prisma);

    await expect(
      service.addContactToBoard({
        workspaceId: "workspace_a",
        boardId,
        stageId,
        contactId
      })
    ).rejects.toMatchObject({ code: "STAGE_NOT_FOUND" });
  });

  it("moves a membership with the workspace/membership composite key after validating the target stage board", async () => {
    const prisma = createMockPrisma();
    const service = createBoardsService(prisma);

    await service.moveContactToStage({
      workspaceId: "workspace_a",
      membershipId,
      stageId: nextStageId
    });

    expect(prisma.contactBoardMembership.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: "workspace_a", id: membershipId },
      include: { contact: true }
    });
    expect(prisma.contactBoardStage.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: "workspace_a", boardId, id: nextStageId }
    });
    expect(prisma.contactBoardMembership.update).toHaveBeenCalledWith({
      where: {
        workspaceId_id: {
          workspaceId: "workspace_a",
          id: membershipId
        }
      },
      data: { stageId: nextStageId },
      include: { contact: true }
    });
  });

  it("rejects moves to a stage on another board", async () => {
    const prisma = createMockPrisma({
      contactBoardMembership: {
        ...createMockPrisma().contactBoardMembership,
        findFirst: vi
          .fn<PrismaLike["contactBoardMembership"]["findFirst"]>()
          .mockResolvedValue({ ...baseMembership, boardId: otherBoardId })
      },
      contactBoardStage: {
        ...createMockPrisma().contactBoardStage,
        findFirst: vi
          .fn<PrismaLike["contactBoardStage"]["findFirst"]>()
          .mockResolvedValue(null)
      }
    });
    const service = createBoardsService(prisma);

    await expect(
      service.moveContactToStage({
        workspaceId: "workspace_a",
        membershipId,
        stageId
      })
    ).rejects.toMatchObject({ code: "STAGE_NOT_FOUND" });
  });
});

describe("boards routes", () => {
  it("returns board DTOs with stages", async () => {
    const { app, publish } = await buildBoardsApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/boards"
      });

      expect(response.statusCode).toBe(200);
      expect(aggregateBoardSchema.array().parse(response.json())).toEqual(response.json());
    } finally {
      await app.close();
    }
  });

  it("creates board memberships", async () => {
    const { app, publish } = await buildBoardsApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: `/boards/${boardId}/memberships`,
        payload: {
          contactId,
          stageId,
          isPrimary: true
        }
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      contactBoardMembershipSchema.parse(body);
      expect(body.contact.name).toBe("Ana Silva");
      expect(realtimeEventSchema.parse(publish.mock.calls[0]?.[0])).toEqual({
        type: "board_membership.updated",
        workspaceId: "workspace_a",
        payload: contactBoardMembershipSchema.parse(body)
      });
    } finally {
      await app.close();
    }
  });

  it("moves board memberships", async () => {
    const { app, prisma, publish } = await buildBoardsApp();

    try {
      const response = await app.inject({
        method: "PATCH",
        url: `/board-memberships/${membershipId}`,
        payload: {
          stageId: nextStageId
        }
      });

      expect(response.statusCode).toBe(200);
      expect(contactBoardMembershipSchema.parse(response.json())).toEqual(
        expect.objectContaining({ stageId: nextStageId })
      );
      expect(prisma.contactBoardMembership.update).toHaveBeenCalled();
      expect(realtimeEventSchema.parse(publish.mock.calls[0]?.[0])).toEqual({
        type: "board_membership.updated",
        workspaceId: "workspace_a",
        payload: contactBoardMembershipSchema.parse(response.json())
      });
    } finally {
      await app.close();
    }
  });
});
