import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { readEnv } from "../../env.js";
import { createTeamService, TeamServiceError } from "./team.service.js";
import type {
  DepartmentDistributionMode,
  DepartmentMemberRole,
  DepartmentPermissionKey,
  PrismaLike,
  ProductInviteRole
} from "./team.service.js";

const uuidParamSchema = z.string().uuid();
const nullableUuidSchema = z.union([uuidParamSchema, z.null()]);
const permissionSchema = z.object({
  view: z.boolean().default(true),
  reply: z.boolean().default(true),
  transfer: z.boolean().default(true),
  close: z.boolean().default(true)
});

const departmentParamsSchema = z.object({
  departmentId: uuidParamSchema
});

const departmentMemberParamsSchema = z.object({
  departmentId: uuidParamSchema,
  userId: uuidParamSchema
});

const departmentRuleParamsSchema = z.object({
  ruleId: uuidParamSchema
});

const departmentBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  routingOrder: z.number().int().min(0).max(999).optional(),
  distributionMode: z.enum(["manual", "round_robin", "least_open"]).optional(),
  businessHours: z.record(z.string(), z.unknown()).optional(),
  slaFirstResponseMinutes: z.number().int().min(1).max(30 * 24 * 60).nullable().optional(),
  slaResolutionMinutes: z.number().int().min(1).max(90 * 24 * 60).nullable().optional(),
  fallbackDepartmentId: nullableUuidSchema.optional()
});

const departmentUpdateBodySchema = departmentBodySchema.partial();

const departmentMemberBodySchema = z.object({
  userId: uuidParamSchema,
  role: z.enum(["supervisor", "agent"]).default("agent"),
  permissions: permissionSchema.default({
    view: true,
    reply: true,
    transfer: true,
    close: true
  })
});

const departmentChannelRuleBodySchema = z.object({
  channelId: uuidParamSchema,
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(999).default(0)
});

const inviteBodySchema = z.object({
  email: z.string().email().max(254),
  name: z.string().trim().min(1).max(120).optional(),
  role: z.enum(["admin", "member"]).default("member")
});

const updateUserParamsSchema = z.object({
  userId: uuidParamSchema
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
  if (error instanceof TeamServiceError) {
    return reply.code(error.statusCode).send({
      code: error.code,
      error: error.message
    });
  }

  if (isPrismaKnownRequestErrorCode(error, "P2025")) {
    return reply.code(404).send({
      code: "TEAM_NOT_FOUND",
      error: "Team resource not found."
    });
  }

  if (isPrismaKnownRequestErrorCode(error, "P2002")) {
    return reply.code(409).send({
      code: "TEAM_CONFLICT",
      error: "Team resource already exists."
    });
  }

  throw error;
}

export const teamRoutes: FastifyPluginAsync = async (app) => {
  const service = createTeamService(app.prisma as unknown as PrismaLike);

  app.get("/team/users", async (request) => {
    if (request.talk.clerkToken && request.talk.clerkUserId) {
      const env = readEnv();

      await service.syncCurrentUserProfile({
        accountApiUrl: env.PRYMEIRA_ACCOUNT_API_URL,
        clerkToken: request.talk.clerkToken,
        clerkUserId: request.talk.clerkUserId,
        workspaceId: request.talk.workspaceId,
        role: request.talk.role
      });
    }

    return service.listUsers({ workspaceId: request.talk.workspaceId });
  });

  app.get("/team/departments", async (request) =>
    service.listDepartments({ workspaceId: request.talk.workspaceId })
  );

  app.post("/team/invitations", async (request, reply) => {
    if (!requireTeamManage(request.talk.role, reply)) {
      return reply;
    }

    const body = inviteBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid team invitation request." });
    }

    try {
      if (!request.talk.clerkToken) {
        return reply.code(401).send({
          code: "TEAM_HUB_INVITE_FAILED",
          error: "Authenticated Clerk token is required to invite users."
        });
      }

      const env = readEnv();

      return await service.inviteProductMember({
        accountApiUrl: env.PRYMEIRA_ACCOUNT_API_URL,
        productKey: env.PRYMEIRA_PRODUCT_KEY,
        clerkToken: request.talk.clerkToken,
        email: body.data.email,
        name: body.data.name,
        role: body.data.role as ProductInviteRole
      });
    } catch (error) {
      return handleTeamError(reply, error);
    }
  });

  app.post("/team/departments", async (request, reply) => {
    if (!requireTeamManage(request.talk.role, reply)) {
      return reply;
    }

    const body = departmentBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid department request." });
    }

    try {
      const department = await service.createDepartment({
        workspaceId: request.talk.workspaceId,
        name: body.data.name,
        description: body.data.description,
        routingOrder: body.data.routingOrder,
        distributionMode: body.data.distributionMode as DepartmentDistributionMode | undefined,
        businessHours: body.data.businessHours,
        slaFirstResponseMinutes: body.data.slaFirstResponseMinutes,
        slaResolutionMinutes: body.data.slaResolutionMinutes,
        fallbackDepartmentId: body.data.fallbackDepartmentId
      });

      return reply.code(201).send(department);
    } catch (error) {
      return handleTeamError(reply, error);
    }
  });

  app.patch("/team/departments/:departmentId", async (request, reply) => {
    if (!requireTeamManage(request.talk.role, reply)) {
      return reply;
    }

    const params = departmentParamsSchema.safeParse(request.params);
    const body = departmentUpdateBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid department request." });
    }

    try {
      return await service.updateDepartment({
        workspaceId: request.talk.workspaceId,
        departmentId: params.data.departmentId,
        name: body.data.name,
        description: body.data.description,
        routingOrder: body.data.routingOrder,
        distributionMode: body.data.distributionMode as DepartmentDistributionMode | undefined,
        businessHours: body.data.businessHours,
        slaFirstResponseMinutes: body.data.slaFirstResponseMinutes,
        slaResolutionMinutes: body.data.slaResolutionMinutes,
        fallbackDepartmentId: body.data.fallbackDepartmentId
      });
    } catch (error) {
      return handleTeamError(reply, error);
    }
  });

  app.put("/team/departments/:departmentId/members", async (request, reply) => {
    if (!requireTeamManage(request.talk.role, reply)) {
      return reply;
    }

    const params = departmentParamsSchema.safeParse(request.params);
    const body = departmentMemberBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid department member request." });
    }

    try {
      return await service.upsertDepartmentMember({
        workspaceId: request.talk.workspaceId,
        departmentId: params.data.departmentId,
        userId: body.data.userId,
        role: body.data.role as DepartmentMemberRole,
        permissions: body.data.permissions as Record<DepartmentPermissionKey, boolean>
      });
    } catch (error) {
      return handleTeamError(reply, error);
    }
  });

  app.delete("/team/departments/:departmentId/members/:userId", async (request, reply) => {
    if (!requireTeamManage(request.talk.role, reply)) {
      return reply;
    }

    const params = departmentMemberParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid department member request." });
    }

    try {
      return await service.removeDepartmentMember({
        workspaceId: request.talk.workspaceId,
        departmentId: params.data.departmentId,
        userId: params.data.userId
      });
    } catch (error) {
      return handleTeamError(reply, error);
    }
  });

  app.put("/team/departments/:departmentId/channel-rules", async (request, reply) => {
    if (!requireTeamManage(request.talk.role, reply)) {
      return reply;
    }

    const params = departmentParamsSchema.safeParse(request.params);
    const body = departmentChannelRuleBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid department channel rule request." });
    }

    try {
      return await service.upsertDepartmentChannelRule({
        workspaceId: request.talk.workspaceId,
        departmentId: params.data.departmentId,
        channelId: body.data.channelId,
        enabled: body.data.enabled,
        priority: body.data.priority
      });
    } catch (error) {
      return handleTeamError(reply, error);
    }
  });

  app.delete("/team/department-channel-rules/:ruleId", async (request, reply) => {
    if (!requireTeamManage(request.talk.role, reply)) {
      return reply;
    }

    const params = departmentRuleParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid department channel rule request." });
    }

    try {
      return await service.removeDepartmentChannelRule({
        workspaceId: request.talk.workspaceId,
        ruleId: params.data.ruleId
      });
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
        role: body.data.role,
        callerRole: request.talk.role
      });
    } catch (error) {
      return handleTeamError(reply, error);
    }
  });
};
