import Fastify from "fastify";
import type { UserRole } from "@prymeira-talk/shared";
import { describe, expect, it, vi } from "vitest";
import { teamRoutes } from "./team.routes.js";
import { createTeamService } from "./team.service.js";
import type { PrismaLike } from "./team.service.js";

type MockPrisma = {
  userProfile: {
    findMany: any;
    findFirst: any;
    update: any;
  };
  department: {
    findMany: any;
    create: any;
  };
};

const userId = "00000000-0000-4000-8000-000000000301";
const otherUserId = "00000000-0000-4000-8000-000000000302";
const departmentId = "00000000-0000-4000-8000-000000000303";

const baseUsers = [
  {
    id: userId,
    workspaceId: "workspace_a",
    clerkUserId: "clerk_user_a",
    role: "agent" as const,
    displayName: "Ana Torres",
    avatarUrl: null,
    presenceState: "online",
    createdAt: new Date("2026-05-21T12:00:00.000Z"),
    updatedAt: new Date("2026-05-21T12:00:00.000Z")
  },
  {
    id: otherUserId,
    workspaceId: "workspace_a",
    clerkUserId: "clerk_user_b",
    role: "manager" as const,
    displayName: "Bruno Lima",
    avatarUrl: null,
    presenceState: "busy",
    createdAt: new Date("2026-05-21T12:05:00.000Z"),
    updatedAt: new Date("2026-05-21T12:05:00.000Z")
  }
];

const baseDepartment = {
  id: departmentId,
  workspaceId: "workspace_a",
  name: "Comercial",
  routingOrder: 10,
  createdAt: new Date("2026-05-21T13:00:00.000Z"),
  updatedAt: new Date("2026-05-21T13:00:00.000Z")
};

function createMockPrisma(overrides: Partial<MockPrisma> = {}): MockPrisma & PrismaLike {
  return {
    userProfile: {
      findMany: overrides.userProfile?.findMany ?? vi.fn().mockResolvedValue(baseUsers),
      findFirst: overrides.userProfile?.findFirst ?? vi.fn().mockResolvedValue(baseUsers[0]),
      update:
        overrides.userProfile?.update ??
        vi.fn().mockImplementation(async (args) => ({
          ...baseUsers[0],
          role: args.data.role,
          updatedAt: new Date("2026-05-21T13:10:00.000Z")
        }))
    },
    department: {
      findMany: overrides.department?.findMany ?? vi.fn().mockResolvedValue([baseDepartment]),
      create:
        overrides.department?.create ??
        vi.fn().mockImplementation(async (args) => ({
          ...baseDepartment,
          ...args.data
        }))
    }
  } as MockPrisma & PrismaLike;
}

async function buildTeamApp(input: { prisma?: MockPrisma & PrismaLike; role?: UserRole } = {}) {
  const app = Fastify({ logger: false });
  const prisma = input.prisma ?? createMockPrisma();
  const role = input.role ?? "manager";

  app.decorate("prisma", prisma as never);
  app.addHook("preHandler", async (request) => {
    request.talk = { workspaceId: "workspace_a", role };
  });
  await app.register(teamRoutes);

  return { app, prisma };
}

describe("team service", () => {
  it("lists users scoped by workspace", async () => {
    const prisma = createMockPrisma();
    const service = createTeamService(prisma);

    const users = await service.listUsers({ workspaceId: "workspace_a" });

    expect(users).toHaveLength(2);
    expect(users[0]).toEqual(
      expect.objectContaining({
        id: userId,
        workspaceId: "workspace_a",
        displayName: "Ana Torres",
        role: "agent"
      })
    );
    expect(prisma.userProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "workspace_a" }
      })
    );
  });

  it("creates a department in the current workspace", async () => {
    const prisma = createMockPrisma();
    const service = createTeamService(prisma);

    const department = await service.createDepartment({
      workspaceId: "workspace_a",
      name: " Comercial ",
      routingOrder: 10
    });

    expect(department).toEqual(
      expect.objectContaining({
        workspaceId: "workspace_a",
        name: "Comercial",
        routingOrder: 10
      })
    );
    expect(prisma.department.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace_a",
        name: "Comercial",
        routingOrder: 10
      }
    });
  });
});

describe("team routes", () => {
  it.each(["owner", "manager"] as const)(
    "allows %s to update a user role",
    async (role) => {
      const { app } = await buildTeamApp({ role });

      try {
        const response = await app.inject({
          method: "PATCH",
          url: `/team/users/${userId}`,
          payload: { role: "manager" }
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(
          expect.objectContaining({
            id: userId,
            workspaceId: "workspace_a",
            role: "manager"
          })
        );
      } finally {
        await app.close();
      }
    }
  );

  it("rejects role updates when caller is an agent", async () => {
    const { app, prisma } = await buildTeamApp({ role: "agent" });

    try {
      const response = await app.inject({
        method: "PATCH",
        url: `/team/users/${userId}`,
        payload: { role: "manager" }
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        code: "TEAM_MANAGE_FORBIDDEN",
        error: "Team management permission required."
      });
      expect(prisma.userProfile.update).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects owner promotion when caller is a manager", async () => {
    const { app, prisma } = await buildTeamApp({ role: "manager" });

    try {
      const response = await app.inject({
        method: "PATCH",
        url: `/team/users/${userId}`,
        payload: { role: "owner" }
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        code: "TEAM_OWNER_ROLE_FORBIDDEN",
        error: "Only owners can assign or edit owner roles."
      });
      expect(prisma.userProfile.update).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects owner edits when caller is a manager", async () => {
    const prisma = createMockPrisma({
      userProfile: {
        findMany: vi.fn(),
        findFirst: vi.fn().mockResolvedValue({ ...baseUsers[0], role: "owner" }),
        update: vi.fn()
      }
    });
    const { app } = await buildTeamApp({ role: "manager", prisma });

    try {
      const response = await app.inject({
        method: "PATCH",
        url: `/team/users/${userId}`,
        payload: { role: "agent" }
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        code: "TEAM_OWNER_ROLE_FORBIDDEN",
        error: "Only owners can assign or edit owner roles."
      });
      expect(prisma.userProfile.update).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
}
);
