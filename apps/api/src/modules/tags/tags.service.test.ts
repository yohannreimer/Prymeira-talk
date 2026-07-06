import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { tagsRoutes } from "./tags.routes.js";
import { createTagsService, TagsServiceError } from "./tags.service.js";
import type { TagsPrismaLike } from "./tags.service.js";

const workspaceId = "local_workspace";
const tagId = "00000000-0000-4000-8000-000000000701";
const now = new Date("2026-06-23T18:00:00.000Z");

const baseTag = {
  id: tagId,
  workspaceId,
  name: "VIP",
  color: "#24564a",
  useGuide: "Use para clientes prioritários.",
  isActive: true,
  createdAt: now,
  updatedAt: now,
  _count: {
    allowedAgents: 2,
    conversations: 5
  }
};

type MockPrisma = {
  tag: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
};

function buildPrisma(overrides: Partial<MockPrisma["tag"]> = {}): MockPrisma & TagsPrismaLike {
  return {
    tag: {
      findMany: overrides.findMany ?? vi.fn().mockResolvedValue([baseTag]),
      create:
        overrides.create ??
        vi.fn().mockImplementation(async (args) => ({
          ...baseTag,
          ...args.data
        })),
      update:
        overrides.update ??
        vi.fn().mockImplementation(async (args) => ({
          ...baseTag,
          ...args.data
        }))
    }
  } as MockPrisma & TagsPrismaLike;
}

async function createApp(input: {
  role?: "owner" | "manager" | "agent";
  prisma?: MockPrisma & TagsPrismaLike;
} = {}) {
  const app = Fastify();
  app.decorate("prisma", (input.prisma ?? buildPrisma()) as never);
  app.addHook("preHandler", async (request) => {
    request.talk = { workspaceId, role: input.role ?? "manager" };
  });
  await app.register(tagsRoutes);
  return app;
}

describe("createTagsService", () => {
  it("lists workspace tags with counts and active/name ordering", async () => {
    const prisma = buildPrisma();
    const service = createTagsService(prisma);

    const tags = await service.listTags({ workspaceId });

    expect(tags).toEqual([
      {
        id: tagId,
        workspaceId,
        name: "VIP",
        color: "#24564a",
        useGuide: "Use para clientes prioritários.",
        isActive: true,
        agentCount: 2,
        conversationCount: 5,
        createdAt: "2026-06-23T18:00:00.000Z",
        updatedAt: "2026-06-23T18:00:00.000Z"
      }
    ]);
    expect(prisma.tag.findMany).toHaveBeenCalledWith({
      where: { workspaceId },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      include: {
        _count: {
          select: {
            allowedAgents: true,
            conversations: true
          }
        }
      }
    });
  });

  it("creates an active tag and falls back invalid colors", async () => {
    const prisma = buildPrisma();
    const service = createTagsService(prisma);

    const tag = await service.createTag({
      workspaceId,
      name: " Retenção ",
      color: "not-a-color",
      useGuide: " Use para risco de churn. "
    });

    expect(tag).toEqual(
      expect.objectContaining({
        name: "Retenção",
        color: "#24564a",
        useGuide: "Use para risco de churn.",
        isActive: true
      })
    );
    expect(prisma.tag.create).toHaveBeenCalledWith({
      data: {
        workspaceId,
        name: "Retenção",
        color: "#24564a",
        useGuide: "Use para risco de churn.",
        isActive: true
      },
      include: {
        _count: {
          select: {
            allowedAgents: true,
            conversations: true
          }
        }
      }
    });
  });

  it("rejects empty names and use guides", async () => {
    const prisma = buildPrisma();
    const service = createTagsService(prisma);

    await expect(
      service.createTag({
        workspaceId,
        name: " ",
        color: "#123456",
        useGuide: "Use para clientes prioritários."
      })
    ).rejects.toBeInstanceOf(TagsServiceError);
    await expect(
      service.createTag({
        workspaceId,
        name: "VIP",
        color: "#123456",
        useGuide: " "
      })
    ).rejects.toMatchObject({ code: "TAG_INVALID_INPUT" });
    expect(prisma.tag.create).not.toHaveBeenCalled();
  });

  it("updates provided tag fields inside the workspace", async () => {
    const prisma = buildPrisma();
    const service = createTagsService(prisma);

    const tag = await service.updateTag({
      workspaceId,
      tagId,
      data: {
        name: " Alto valor ",
        color: "#aabbcc",
        useGuide: " Use para contas estratégicas. ",
        isActive: false
      }
    });

    expect(tag).toEqual(
      expect.objectContaining({
        name: "Alto valor",
        color: "#aabbcc",
        useGuide: "Use para contas estratégicas.",
        isActive: false
      })
    );
    expect(prisma.tag.update).toHaveBeenCalledWith({
      where: { workspaceId_id: { workspaceId, id: tagId } },
      data: {
        name: "Alto valor",
        color: "#aabbcc",
        useGuide: "Use para contas estratégicas.",
        isActive: false
      },
      include: {
        _count: {
          select: {
            allowedAgents: true,
            conversations: true
          }
        }
      }
    });
  });
});

describe("tags routes", () => {
  it("lists tags for the request workspace", async () => {
    const prisma = buildPrisma();
    const app = await createApp({ prisma });
    const response = await app.inject({ method: "GET", url: "/tags" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        id: tagId,
        workspaceId,
        name: "VIP",
        color: "#24564a",
        useGuide: "Use para clientes prioritários.",
        isActive: true,
        agentCount: 2,
        conversationCount: 5,
        createdAt: "2026-06-23T18:00:00.000Z",
        updatedAt: "2026-06-23T18:00:00.000Z"
      }
    ]);
  });

  it("requires automation management permission to create tags", async () => {
    const prisma = buildPrisma({ create: vi.fn() });
    const app = await createApp({ role: "agent", prisma });
    const response = await app.inject({
      method: "POST",
      url: "/tags",
      payload: {
        name: "VIP",
        color: "#123456",
        useGuide: "Use para clientes prioritários."
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      code: "TAG_MANAGE_FORBIDDEN",
      error: "Tag management permission required."
    });
    expect(prisma.tag.create).not.toHaveBeenCalled();
  });

  it("creates tags for managers", async () => {
    const prisma = buildPrisma();
    const app = await createApp({ prisma });
    const response = await app.inject({
      method: "POST",
      url: "/tags",
      payload: {
        name: "VIP",
        color: "#123456",
        useGuide: "Use para clientes prioritários."
      }
    });

    expect(response.statusCode).toBe(201);
    expect(prisma.tag.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId,
          isActive: true
        })
      })
    );
  });

  it("updates tags for managers", async () => {
    const prisma = buildPrisma();
    const app = await createApp({ prisma });
    const response = await app.inject({
      method: "PATCH",
      url: `/tags/${tagId}`,
      payload: {
        name: "Alto valor",
        color: "#abcdef",
        useGuide: "Use para contas estratégicas.",
        isActive: false
      }
    });

    expect(response.statusCode).toBe(200);
    expect(prisma.tag.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_id: { workspaceId, id: tagId } },
        data: expect.objectContaining({ isActive: false })
      })
    );
  });

  it("rejects invalid tag update requests", async () => {
    const prisma = buildPrisma({ update: vi.fn() });
    const app = await createApp({ prisma });
    const response = await app.inject({
      method: "PATCH",
      url: "/tags/not-a-uuid",
      payload: { name: "VIP" }
    });

    expect(response.statusCode).toBe(400);
    expect(prisma.tag.update).not.toHaveBeenCalled();
  });
});
