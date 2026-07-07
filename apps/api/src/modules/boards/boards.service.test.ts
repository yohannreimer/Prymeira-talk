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
    update: ReturnType<typeof vi.fn<PrismaLike["contactBoard"]["update"]>>;
    delete: ReturnType<typeof vi.fn<PrismaLike["contactBoard"]["delete"]>>;
  };
  contactBoardChannel: {
    deleteMany: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
  };
  contactBoardStage: {
    create: ReturnType<typeof vi.fn<PrismaLike["contactBoardStage"]["create"]>>;
    findMany: ReturnType<typeof vi.fn<PrismaLike["contactBoardStage"]["findMany"]>>;
    findFirst: ReturnType<typeof vi.fn<PrismaLike["contactBoardStage"]["findFirst"]>>;
    update: ReturnType<typeof vi.fn<PrismaLike["contactBoardStage"]["update"]>>;
    delete: ReturnType<typeof vi.fn<PrismaLike["contactBoardStage"]["delete"]>>;
  };
  contactBoardStageTag: {
    deleteMany: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
  };
  contactBoardMembership: {
    findMany: ReturnType<typeof vi.fn<PrismaLike["contactBoardMembership"]["findMany"]>>;
    findFirst: ReturnType<typeof vi.fn<PrismaLike["contactBoardMembership"]["findFirst"]>>;
    upsert: ReturnType<typeof vi.fn<PrismaLike["contactBoardMembership"]["upsert"]>>;
    update: ReturnType<typeof vi.fn<PrismaLike["contactBoardMembership"]["update"]>>;
    updateMany: ReturnType<typeof vi.fn<PrismaLike["contactBoardMembership"]["updateMany"]>>;
    delete: ReturnType<typeof vi.fn<PrismaLike["contactBoardMembership"]["delete"]>>;
    count: ReturnType<typeof vi.fn<PrismaLike["contactBoardMembership"]["count"]>>;
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
  isPrimaryPipeline: false,
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
        vi.fn<PrismaLike["contactBoard"]["create"]>().mockResolvedValue({
          ...baseBoard,
          stages: []
        }),
      findFirst:
        overrides.contactBoard?.findFirst ??
        vi.fn<PrismaLike["contactBoard"]["findFirst"]>().mockResolvedValue({
          ...baseBoard,
          stages: baseStages
        }),
      update:
        overrides.contactBoard?.update ??
        vi.fn<PrismaLike["contactBoard"]["update"]>().mockResolvedValue({
          ...baseBoard,
          name: "Vendas",
          stages: baseStages
        }),
      delete:
        overrides.contactBoard?.delete ??
        vi.fn<PrismaLike["contactBoard"]["delete"]>().mockResolvedValue(baseBoard)
    },
    contactBoardChannel: {
      deleteMany:
        overrides.contactBoardChannel?.deleteMany ??
        vi.fn().mockResolvedValue({ count: 0 }),
      createMany:
        overrides.contactBoardChannel?.createMany ??
        vi.fn().mockResolvedValue({ count: 1 })
    },
    contactBoardStage: {
      create:
        overrides.contactBoardStage?.create ??
        vi.fn<PrismaLike["contactBoardStage"]["create"]>().mockResolvedValue(baseStages[0]),
      findMany:
        overrides.contactBoardStage?.findMany ??
        vi.fn<PrismaLike["contactBoardStage"]["findMany"]>().mockResolvedValue(baseStages),
      findFirst:
        overrides.contactBoardStage?.findFirst ??
        vi.fn<PrismaLike["contactBoardStage"]["findFirst"]>().mockResolvedValue(baseStages[0]),
      update:
        overrides.contactBoardStage?.update ??
        vi.fn<PrismaLike["contactBoardStage"]["update"]>().mockResolvedValue({
          ...baseStages[0],
          name: "Atualizada"
        }),
      delete:
        overrides.contactBoardStage?.delete ??
        vi.fn<PrismaLike["contactBoardStage"]["delete"]>().mockResolvedValue(baseStages[0])
    },
    contactBoardStageTag: {
      deleteMany:
        overrides.contactBoardStageTag?.deleteMany ??
        vi.fn().mockResolvedValue({ count: 0 }),
      createMany:
        overrides.contactBoardStageTag?.createMany ??
        vi.fn().mockResolvedValue({ count: 1 })
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
        }),
      delete:
        overrides.contactBoardMembership?.delete ??
        vi.fn<PrismaLike["contactBoardMembership"]["delete"]>().mockResolvedValue(
          baseMembership
        ),
      count:
        overrides.contactBoardMembership?.count ??
        vi.fn<PrismaLike["contactBoardMembership"]["count"]>().mockResolvedValue(0)
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

const tagTriggerIncludeExpectation = {
  tagTriggers: {
    include: {
      tag: {
        select: {
          id: true,
          name: true,
          color: true,
          isActive: true
        }
      }
    }
  }
};

const boardRuleIncludeExpectation = {
  channels: {
    include: {
      channel: {
        select: {
          id: true,
          displayName: true,
          provider: true,
          phoneNumber: true
        }
      }
    }
  },
  stages: {
    orderBy: { order: "asc" },
    include: tagTriggerIncludeExpectation
  }
};

describe("boards service", () => {
  it("creates a board with selected channels and primary pipeline setting", async () => {
    const prisma = createMockPrisma();
    const service = createBoardsService(prisma);

    await service.createBoard({
      workspaceId: "workspace_a",
      name: "Vendas",
      description: "",
      channelIds: ["00000000-0000-4000-8000-000000000060"],
      isPrimaryPipeline: true
    });

    expect(prisma.contactBoard.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isPrimaryPipeline: true,
          channels: {
            createMany: {
              data: [
                {
                  workspaceId: "workspace_a",
                  channelId: "00000000-0000-4000-8000-000000000060"
                }
              ],
              skipDuplicates: true
            }
          }
        })
      })
    );
  });

  it("updates stage tag triggers by replacing mappings for that stage", async () => {
    const prisma = createMockPrisma();
    const service = createBoardsService(prisma);

    await service.updateStage({
      workspaceId: "workspace_a",
      boardId,
      stageId,
      tagIds: ["00000000-0000-4000-8000-000000000070"]
    });

    expect(prisma.contactBoardStageTag.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace_a", boardId, stageId }
    });
    expect(prisma.contactBoardStageTag.createMany).toHaveBeenCalledWith({
      data: [
        {
          workspaceId: "workspace_a",
          boardId,
          stageId,
          tagId: "00000000-0000-4000-8000-000000000070"
        }
      ],
      skipDuplicates: true
    });
  });

  it("lists boards inside a workspace with stages ordered by sort order", async () => {
    const prisma = createMockPrisma();
    const service = createBoardsService(prisma);

    const boards = await service.listBoards({ workspaceId: "workspace_a" });

    expect(prisma.contactBoard.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace_a" },
      include: boardRuleIncludeExpectation,
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
      include: boardRuleIncludeExpectation
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
        isPrimary: true,
        lastMovedBy: "manual",
        lastRuleAppliedAt: null
      },
      update: {
        stageId,
        isPrimary: true,
        lastMovedBy: "manual",
        lastRuleAppliedAt: null
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
      data: {
        stageId: nextStageId,
        isPrimary: true,
        lastMovedBy: "manual",
        lastRuleAppliedAt: null
      },
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
      data: {
        stageId: nextStageId,
        lastMovedBy: "manual",
        lastRuleAppliedAt: null
      },
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

  it("updates a board through the workspace composite key and returns stages", async () => {
    const prisma = createMockPrisma();
    const service = createBoardsService(prisma);

    const board = await service.updateBoard({
      workspaceId: "workspace_a",
      boardId,
      name: "Vendas",
      description: ""
    });

    expect(prisma.contactBoard.update).toHaveBeenCalledWith({
      where: {
        workspaceId_id: {
          workspaceId: "workspace_a",
          id: boardId
        }
      },
      data: {
        name: "Vendas",
        description: null
      },
      include: boardRuleIncludeExpectation
    });
    expect(board.name).toBe("Vendas");
  });

  it("deletes a workspace board after validating ownership", async () => {
    const prisma = createMockPrisma();
    const service = createBoardsService(prisma);

    const result = await service.deleteBoard({
      workspaceId: "workspace_a",
      boardId
    });

    expect(prisma.contactBoard.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: "workspace_a", id: boardId },
      include: boardRuleIncludeExpectation
    });
    expect(prisma.contactBoard.delete).toHaveBeenCalledWith({
      where: {
        workspaceId_id: {
          workspaceId: "workspace_a",
          id: boardId
        }
      }
    });
    expect(result).toEqual({ ok: true, boardId });
  });

  it("updates a stage after validating that it belongs to the board", async () => {
    const prisma = createMockPrisma();
    const service = createBoardsService(prisma);

    const stage = await service.updateStage({
      workspaceId: "workspace_a",
      boardId,
      stageId,
      name: "Em atendimento",
      color: "#123456"
    });

    expect(prisma.contactBoardStage.update).toHaveBeenCalledWith({
      where: {
        workspaceId_boardId_id: {
          workspaceId: "workspace_a",
          boardId,
          id: stageId
        }
      },
      data: {
        name: "Em atendimento",
        color: "#123456"
      },
      include: tagTriggerIncludeExpectation
    });
    expect(stage.name).toBe("Atualizada");
  });

  it("reorders all board stages in one transaction", async () => {
    const prisma = createMockPrisma();
    const service = createBoardsService(prisma);

    const stages = await service.reorderStages({
      workspaceId: "workspace_a",
      boardId,
      stageIds: [nextStageId, stageId]
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.contactBoardStage.update).toHaveBeenNthCalledWith(1, {
      where: {
        workspaceId_boardId_id: {
          workspaceId: "workspace_a",
          boardId,
          id: nextStageId
        }
      },
      data: { order: 0 }
    });
    expect(prisma.contactBoardStage.update).toHaveBeenNthCalledWith(2, {
      where: {
        workspaceId_boardId_id: {
          workspaceId: "workspace_a",
          boardId,
          id: stageId
        }
      },
      data: { order: 1 }
    });
    expect(stages.map((stage) => stage.id)).toEqual([nextStageId, stageId]);
  });

  it("rejects stage reorder payloads that do not include every board stage once", async () => {
    const prisma = createMockPrisma();
    const service = createBoardsService(prisma);

    await expect(
      service.reorderStages({
        workspaceId: "workspace_a",
        boardId,
        stageIds: [stageId]
      })
    ).rejects.toMatchObject({ code: "STAGE_ORDER_INVALID" });
  });

  it("deletes empty stages and blocks non-empty stage deletion", async () => {
    const prisma = createMockPrisma();
    const service = createBoardsService(prisma);

    await expect(
      service.deleteStage({
        workspaceId: "workspace_a",
        boardId,
        stageId
      })
    ).resolves.toEqual({ ok: true, stageId });
    expect(prisma.contactBoardStage.delete).toHaveBeenCalledWith({
      where: {
        workspaceId_boardId_id: {
          workspaceId: "workspace_a",
          boardId,
          id: stageId
        }
      }
    });

    const nonEmptyPrisma = createMockPrisma({
      contactBoardMembership: {
        ...createMockPrisma().contactBoardMembership,
        count: vi.fn<PrismaLike["contactBoardMembership"]["count"]>().mockResolvedValue(1)
      }
    });

    await expect(
      createBoardsService(nonEmptyPrisma).deleteStage({
        workspaceId: "workspace_a",
        boardId,
        stageId
      })
    ).rejects.toMatchObject({ code: "STAGE_NOT_EMPTY" });
  });

  it("removes a board membership by workspace membership key", async () => {
    const prisma = createMockPrisma();
    const service = createBoardsService(prisma);

    const result = await service.removeContactFromBoard({
      workspaceId: "workspace_a",
      membershipId
    });

    expect(prisma.contactBoardMembership.delete).toHaveBeenCalledWith({
      where: {
        workspaceId_id: {
          workspaceId: "workspace_a",
          id: membershipId
        }
      }
    });
    expect(result).toEqual({
      ok: true,
      membershipId,
      boardId,
      contactId
    });
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

  it("updates, reorders, and deletes board records through routes", async () => {
    const { app, prisma } = await buildBoardsApp();

    try {
      const updateBoardResponse = await app.inject({
        method: "PATCH",
        url: `/boards/${boardId}`,
        payload: {
          name: "Vendas"
        }
      });
      expect(updateBoardResponse.statusCode).toBe(200);
      expect(aggregateBoardSchema.parse(updateBoardResponse.json()).name).toBe("Vendas");

      const updateStageResponse = await app.inject({
        method: "PATCH",
        url: `/boards/${boardId}/stages/${stageId}`,
        payload: {
          name: "Atualizada",
          color: "#123456"
        }
      });
      expect(updateStageResponse.statusCode).toBe(200);
      expect(contactBoardStageSchema.parse(updateStageResponse.json()).name).toBe("Atualizada");

      const reorderResponse = await app.inject({
        method: "PATCH",
        url: `/boards/${boardId}/stages/reorder`,
        payload: {
          stageIds: [nextStageId, stageId]
        }
      });
      expect(reorderResponse.statusCode).toBe(200);
      expect(contactBoardStageSchema.array().parse(reorderResponse.json())).toHaveLength(2);

      const deleteStageResponse = await app.inject({
        method: "DELETE",
        url: `/boards/${boardId}/stages/${stageId}`
      });
      expect(deleteStageResponse.statusCode).toBe(200);
      expect(deleteStageResponse.json()).toEqual({ ok: true, stageId });

      const deleteBoardResponse = await app.inject({
        method: "DELETE",
        url: `/boards/${boardId}`
      });
      expect(deleteBoardResponse.statusCode).toBe(200);
      expect(deleteBoardResponse.json()).toEqual({ ok: true, boardId });
      expect(prisma.contactBoard.delete).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("removes board memberships and publishes a deletion event", async () => {
    const { app, publish } = await buildBoardsApp();

    try {
      const response = await app.inject({
        method: "DELETE",
        url: `/board-memberships/${membershipId}`
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        membershipId,
        boardId,
        contactId
      });
      expect(realtimeEventSchema.parse(publish.mock.calls[0]?.[0])).toEqual({
        type: "board_membership.deleted",
        workspaceId: "workspace_a",
        payload: response.json()
      });
    } finally {
      await app.close();
    }
  });
});
