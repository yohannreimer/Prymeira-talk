import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { createTeamService } from "./team.service.js";
import type { PrismaLike } from "./team.service.js";

const uuidParamSchema = z.string().uuid();

const updateUserParamsSchema = z.object({
  userId: uuidParamSchema
});

const createDepartmentBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  routingOrder: z.number().int().min(0).max(999).optional()
});

const updateUserBodySchema = z.object({
  role: z.enum(["owner", "manager", "agent"])
});

function isTeamManager(role: "owner" | "manager" | "agent") {
  return role === "owner" || role === "manager";
}

function requireTeamManage(role: "owner" | "manager" | "agent", reply: FastifyReply) {
  if (isTeamManager(role)) {
    return true;
  }

  reply.code(403).send({
    code: "TEAM_MANAGE_FORBIDDEN",
    error: "Team management permission required."
  });
  return false;
}

function isPrismaKnownRequestErrorCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function handleTeamError(reply: FastifyReply, error: unknown) {
  if (isPrismaKnownRequestErrorCode(error, "P2025")) {
    return reply.code(404).send({
      code: "TEAM_USER_NOT_FOUND",
      error: "Team user not found."
    });
  }

  if (isPrismaKnownRequestErrorCode(error, "P2002")) {
    return reply.code(409).send({
      code: "TEAM_DEPARTMENT_CONFLICT",
      error: "Department already exists."
    });
  }

  throw error;
}

export const teamRoutes: FastifyPluginAsync = async (app) => {
  const service = createTeamService(app.prisma as unknown as PrismaLike);

  app.get("/team/users", async (request) =>
    service.listUsers({ workspaceId: request.talk.workspaceId })
  );

  app.get("/team/departments", async (request) =>
    service.listDepartments({ workspaceId: request.talk.workspaceId })
  );

  app.post("/team/departments", async (request, reply) => {
    if (!requireTeamManage(request.talk.role, reply)) {
      return reply;
    }

    const body = createDepartmentBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid department request." });
    }

    try {
      const department = await service.createDepartment({
        workspaceId: request.talk.workspaceId,
        ...body.data
      });

      return reply.code(201).send(department);
    } catch (error) {
      return handleTeamError(reply, error);
    }
  });

  app.patch("/team/users/:userId", async (request, reply) => {
    if (!requireTeamManage(request.talk.role, reply)) {
      return reply;
    }

    const params = updateUserParamsSchema.safeParse(request.params);
    const body = updateUserBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid team user request." });
    }

    try {
      return await service.updateUserRole({
        workspaceId: request.talk.workspaceId,
        userId: params.data.userId,
        role: body.data.role
      });
    } catch (error) {
      return handleTeamError(reply, error);
    }
  });
};
