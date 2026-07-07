import type { PrismaClient } from "@prisma/client";
import type { UserRole } from "@prymeira-talk/shared";

type DateLike = Date | string;
type JsonLike = unknown;
export type DepartmentDistributionMode = "manual" | "round_robin" | "least_open";
export type DepartmentMemberRole = "supervisor" | "agent";
export type DepartmentPermissionKey = "view" | "reply" | "transfer" | "close";
export type ProductInviteRole = "admin" | "member";

interface UserProfileRecord {
  id: string;
  workspaceId: string;
  clerkUserId: string;
  role: UserRole;
  displayName: string;
  avatarUrl: string | null;
  presenceState: string;
  createdAt: DateLike;
  updatedAt: DateLike;
}

interface DepartmentMemberRecord {
  workspaceId: string;
  departmentId: string;
  userId: string;
  role: DepartmentMemberRole;
  permissions: JsonLike;
  createdAt: DateLike;
  updatedAt: DateLike;
  user?: Pick<UserProfileRecord, "id" | "displayName" | "presenceState" | "role">;
}

interface DepartmentChannelRuleRecord {
  id: string;
  workspaceId: string;
  departmentId: string;
  channelId: string;
  enabled: boolean;
  priority: number;
  createdAt: DateLike;
  updatedAt: DateLike;
  channel?: {
    id: string;
    displayName: string | null;
    phoneNumber: string | null;
    provider: string;
  };
}

interface DepartmentRecord {
  id: string;
  workspaceId: string;
  name: string;
  description?: string | null;
  routingOrder: number;
  distributionMode?: DepartmentDistributionMode;
  businessHours?: JsonLike;
  slaFirstResponseMinutes?: number | null;
  slaResolutionMinutes?: number | null;
  fallbackDepartmentId?: string | null;
  lastAssignedMemberId?: string | null;
  createdAt: DateLike;
  updatedAt: DateLike;
  members?: DepartmentMemberRecord[];
  channelRules?: DepartmentChannelRuleRecord[];
}

type UserFindManyArgs = Parameters<PrismaClient["userProfile"]["findMany"]>[0];
type UserFindFirstArgs = Parameters<PrismaClient["userProfile"]["findFirst"]>[0];
type UserUpdateArgs = Parameters<PrismaClient["userProfile"]["update"]>[0];
type UserUpsertArgs = Parameters<PrismaClient["userProfile"]["upsert"]>[0];
type DepartmentFindManyArgs = Parameters<PrismaClient["department"]["findMany"]>[0];
type DepartmentFindFirstArgs = Parameters<PrismaClient["department"]["findFirst"]>[0];
type DepartmentCreateArgs = Parameters<PrismaClient["department"]["create"]>[0];
type DepartmentUpdateArgs = Parameters<PrismaClient["department"]["update"]>[0];
type DepartmentMemberUpsertArgs = Parameters<PrismaClient["departmentMember"]["upsert"]>[0];
type DepartmentMemberDeleteArgs = Parameters<PrismaClient["departmentMember"]["delete"]>[0];
type DepartmentChannelRuleUpsertArgs = Parameters<PrismaClient["departmentChannelRule"]["upsert"]>[0];
type DepartmentChannelRuleDeleteArgs = Parameters<PrismaClient["departmentChannelRule"]["delete"]>[0];

export interface PrismaLike {
  userProfile: {
    findMany(args: UserFindManyArgs): Promise<UserProfileRecord[]>;
    findFirst(args: UserFindFirstArgs): Promise<UserProfileRecord | null>;
    update(args: UserUpdateArgs): Promise<UserProfileRecord>;
    upsert(args: UserUpsertArgs): Promise<UserProfileRecord>;
  };
  department: {
    findMany(args: DepartmentFindManyArgs): Promise<DepartmentRecord[]>;
    findFirst(args: DepartmentFindFirstArgs): Promise<DepartmentRecord | null>;
    create(args: DepartmentCreateArgs): Promise<DepartmentRecord>;
    update(args: DepartmentUpdateArgs): Promise<DepartmentRecord>;
  };
  departmentMember: {
    upsert(args: DepartmentMemberUpsertArgs): Promise<DepartmentMemberRecord>;
    delete(args: DepartmentMemberDeleteArgs): Promise<DepartmentMemberRecord>;
  };
  departmentChannelRule: {
    upsert(args: DepartmentChannelRuleUpsertArgs): Promise<DepartmentChannelRuleRecord>;
    delete(args: DepartmentChannelRuleDeleteArgs): Promise<DepartmentChannelRuleRecord>;
  };
}

export class TeamServiceError extends Error {
  constructor(
    public code:
      | "TEAM_USER_NOT_FOUND"
      | "TEAM_OWNER_ROLE_FORBIDDEN"
      | "TEAM_DEPARTMENT_NOT_FOUND"
      | "TEAM_HUB_INVITE_FAILED",
    message: string,
    public statusCode = 400
  ) {
    super(message);
  }
}

export interface TeamUserDto {
  id: string;
  workspaceId: string;
  clerkUserId: string;
  role: UserRole;
  displayName: string;
  avatarUrl: string | null;
  presenceState: string;
  createdAt: string;
  updatedAt: string;
}

export interface DepartmentMemberDto {
  userId: string;
  role: DepartmentMemberRole;
  permissions: Record<DepartmentPermissionKey, boolean>;
  displayName: string | null;
  presenceState: string | null;
  userRole: UserRole | null;
  createdAt: string;
  updatedAt: string;
}

export interface DepartmentChannelRuleDto {
  id: string;
  channelId: string;
  enabled: boolean;
  priority: number;
  channelName: string | null;
  channelProvider: string | null;
  channelPhoneNumber: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DepartmentDto {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  routingOrder: number;
  distributionMode: DepartmentDistributionMode;
  businessHours: JsonLike;
  slaFirstResponseMinutes: number | null;
  slaResolutionMinutes: number | null;
  fallbackDepartmentId: string | null;
  members: DepartmentMemberDto[];
  channelRules: DepartmentChannelRuleDto[];
  createdAt: string;
  updatedAt: string;
}

export interface HubInviteResultDto {
  status: "active" | "pending";
  invitation?: {
    id: string;
    email: string;
    role: string;
    status: string;
    productKeys: string[];
    expiresAt: string | null;
    createdAt: string | null;
  };
  member?: {
    customerId: string | null;
    role: string | null;
    status: string | null;
  };
}

interface HubMeProductsResponse {
  customer: {
    id: string;
    email: string | null;
    name: string | null;
  } | null;
}

function toIsoString(value: DateLike) {
  return value instanceof Date ? value.toISOString() : value;
}

function toUserDto(record: UserProfileRecord): TeamUserDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    clerkUserId: record.clerkUserId,
    role: record.role,
    displayName: record.displayName,
    avatarUrl: record.avatarUrl,
    presenceState: record.presenceState,
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt)
  };
}

function toPermissionMap(value: JsonLike): Record<DepartmentPermissionKey, boolean> {
  const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};

  return {
    view: record.view !== false,
    reply: record.reply !== false,
    transfer: record.transfer !== false,
    close: record.close !== false
  };
}

function toMemberDto(record: DepartmentMemberRecord): DepartmentMemberDto {
  return {
    userId: record.userId,
    role: record.role,
    permissions: toPermissionMap(record.permissions),
    displayName: record.user?.displayName ?? null,
    presenceState: record.user?.presenceState ?? null,
    userRole: record.user?.role ?? null,
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt)
  };
}

function toChannelRuleDto(record: DepartmentChannelRuleRecord): DepartmentChannelRuleDto {
  return {
    id: record.id,
    channelId: record.channelId,
    enabled: record.enabled,
    priority: record.priority,
    channelName: record.channel?.displayName ?? null,
    channelProvider: record.channel?.provider ?? null,
    channelPhoneNumber: record.channel?.phoneNumber ?? null,
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt)
  };
}

function toDepartmentDto(record: DepartmentRecord): DepartmentDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    name: record.name,
    description: record.description ?? null,
    routingOrder: record.routingOrder,
    distributionMode: record.distributionMode ?? "manual",
    businessHours: record.businessHours ?? {},
    slaFirstResponseMinutes: record.slaFirstResponseMinutes ?? null,
    slaResolutionMinutes: record.slaResolutionMinutes ?? null,
    fallbackDepartmentId: record.fallbackDepartmentId ?? null,
    members: (record.members ?? []).map(toMemberDto),
    channelRules: (record.channelRules ?? []).map(toChannelRuleDto),
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt)
  };
}

function departmentInclude() {
  return {
    members: {
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            presenceState: true,
            role: true
          }
        }
      },
      orderBy: [{ role: "asc" as const }, { createdAt: "asc" as const }]
    },
    channelRules: {
      include: {
        channel: {
          select: {
            id: true,
            displayName: true,
            phoneNumber: true,
            provider: true
          }
        }
      },
      orderBy: [{ priority: "asc" as const }, { createdAt: "asc" as const }]
    }
  };
}

function normalizeAccountApiUrl(value: string) {
  return value.replace(/\/$/, "");
}

async function hubFetch(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function parseHubInviteResult(payload: unknown): HubInviteResultDto {
  const record = typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : {};
  const status = record.status === "active" ? "active" : "pending";
  const invitation = typeof record.invitation === "object" && record.invitation !== null
    ? record.invitation as Record<string, unknown>
    : null;
  const member = typeof record.member === "object" && record.member !== null
    ? record.member as Record<string, unknown>
    : null;

  return {
    status,
    ...(invitation
      ? {
          invitation: {
            id: String(invitation.id ?? ""),
            email: String(invitation.email ?? ""),
            role: String(invitation.role ?? ""),
            status: String(invitation.status ?? ""),
            productKeys: Array.isArray(invitation.product_keys)
              ? invitation.product_keys.filter((item): item is string => typeof item === "string")
              : [],
            expiresAt: typeof invitation.expires_at === "string" ? invitation.expires_at : null,
            createdAt: typeof invitation.created_at === "string" ? invitation.created_at : null
          }
        }
      : {}),
    ...(member
      ? {
          member: {
            customerId: typeof member.customerId === "string"
              ? member.customerId
              : typeof member.customer_id === "string"
                ? member.customer_id
                : null,
            role: typeof member.role === "string" ? member.role : null,
            status: typeof member.status === "string" ? member.status : null
          }
        }
      : {})
  };
}

function parseHubMeProducts(payload: unknown): HubMeProductsResponse {
  const record = typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : {};
  const customer = typeof record.customer === "object" && record.customer !== null
    ? record.customer as Record<string, unknown>
    : null;

  return {
    customer: customer
      ? {
          id: String(customer.id ?? ""),
          email: typeof customer.email === "string" ? customer.email : null,
          name: typeof customer.name === "string" ? customer.name : null
        }
      : null
  };
}

export function createTeamService(prisma: PrismaLike) {
  return {
    async syncCurrentUserProfile(input: {
      accountApiUrl: string;
      clerkToken: string;
      clerkUserId: string;
      workspaceId: string;
      role: UserRole;
    }): Promise<TeamUserDto | null> {
      const response = await hubFetch(
        `${normalizeAccountApiUrl(input.accountApiUrl)}/me/products`,
        {
          headers: {
            Authorization: `Bearer ${input.clerkToken}`
          }
        },
        3000
      ).catch(() => null);

      if (!response?.ok) {
        return null;
      }

      const hubProfile = parseHubMeProducts(await response.json());
      const displayName =
        hubProfile.customer?.name?.trim() ||
        hubProfile.customer?.email?.trim() ||
        input.clerkUserId;

      const user = await prisma.userProfile.upsert({
        where: {
          workspaceId_clerkUserId: {
            workspaceId: input.workspaceId,
            clerkUserId: input.clerkUserId
          }
        },
        update: {
          displayName
        },
        create: {
          workspaceId: input.workspaceId,
          clerkUserId: input.clerkUserId,
          role: input.role,
          displayName,
          presenceState: "online"
        }
      });

      return toUserDto(user);
    },

    async listUsers(input: { workspaceId: string }): Promise<TeamUserDto[]> {
      const users = await prisma.userProfile.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: [{ role: "asc" }, { displayName: "asc" }],
        take: 100
      });

      return users.map(toUserDto);
    },

    async listDepartments(input: { workspaceId: string }): Promise<DepartmentDto[]> {
      const departments = await prisma.department.findMany({
        where: { workspaceId: input.workspaceId },
        include: departmentInclude(),
        orderBy: [{ routingOrder: "asc" }, { name: "asc" }],
        take: 100
      });

      return departments.map(toDepartmentDto);
    },

    async createDepartment(input: {
      workspaceId: string;
      name: string;
      description?: string | null;
      routingOrder?: number;
      distributionMode?: DepartmentDistributionMode;
      businessHours?: JsonLike;
      slaFirstResponseMinutes?: number | null;
      slaResolutionMinutes?: number | null;
      fallbackDepartmentId?: string | null;
    }): Promise<DepartmentDto> {
      const department = await prisma.department.create({
        data: {
          workspaceId: input.workspaceId,
          name: input.name.trim(),
          description: input.description?.trim() || null,
          routingOrder: input.routingOrder ?? 0,
          distributionMode: input.distributionMode ?? "manual",
          businessHours: input.businessHours ?? {},
          slaFirstResponseMinutes: input.slaFirstResponseMinutes ?? null,
          slaResolutionMinutes: input.slaResolutionMinutes ?? null,
          fallbackDepartmentId: input.fallbackDepartmentId ?? null
        },
        include: departmentInclude()
      });

      return toDepartmentDto(department);
    },

    async updateDepartment(input: {
      workspaceId: string;
      departmentId: string;
      name?: string;
      description?: string | null;
      routingOrder?: number;
      distributionMode?: DepartmentDistributionMode;
      businessHours?: JsonLike;
      slaFirstResponseMinutes?: number | null;
      slaResolutionMinutes?: number | null;
      fallbackDepartmentId?: string | null;
    }): Promise<DepartmentDto> {
      const department = await prisma.department.update({
        where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.departmentId } },
        data: {
          ...(typeof input.name === "string" ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
          ...(typeof input.routingOrder === "number" ? { routingOrder: input.routingOrder } : {}),
          ...(input.distributionMode ? { distributionMode: input.distributionMode } : {}),
          ...(input.businessHours !== undefined ? { businessHours: input.businessHours ?? {} } : {}),
          ...(input.slaFirstResponseMinutes !== undefined
            ? { slaFirstResponseMinutes: input.slaFirstResponseMinutes }
            : {}),
          ...(input.slaResolutionMinutes !== undefined
            ? { slaResolutionMinutes: input.slaResolutionMinutes }
            : {}),
          ...(input.fallbackDepartmentId !== undefined
            ? { fallbackDepartmentId: input.fallbackDepartmentId }
            : {})
        },
        include: departmentInclude()
      });

      return toDepartmentDto(department);
    },

    async upsertDepartmentMember(input: {
      workspaceId: string;
      departmentId: string;
      userId: string;
      role: DepartmentMemberRole;
      permissions: Record<DepartmentPermissionKey, boolean>;
    }): Promise<DepartmentDto> {
      await prisma.department.findFirst({
        where: { workspaceId: input.workspaceId, id: input.departmentId }
      }).then((department) => {
        if (!department) {
          throw new TeamServiceError("TEAM_DEPARTMENT_NOT_FOUND", "Department not found.", 404);
        }
      });

      await prisma.userProfile.findFirst({
        where: { workspaceId: input.workspaceId, id: input.userId }
      }).then((user) => {
        if (!user) {
          throw new TeamServiceError("TEAM_USER_NOT_FOUND", "Team user not found.", 404);
        }
      });

      await prisma.departmentMember.upsert({
        where: {
          workspaceId_departmentId_userId: {
            workspaceId: input.workspaceId,
            departmentId: input.departmentId,
            userId: input.userId
          }
        },
        update: {
          role: input.role,
          permissions: input.permissions
        },
        create: {
          workspaceId: input.workspaceId,
          departmentId: input.departmentId,
          userId: input.userId,
          role: input.role,
          permissions: input.permissions
        }
      });

      const department = await prisma.department.findFirst({
        where: { workspaceId: input.workspaceId, id: input.departmentId },
        include: departmentInclude()
      });
      if (!department) {
        throw new TeamServiceError("TEAM_DEPARTMENT_NOT_FOUND", "Department not found.", 404);
      }

      return toDepartmentDto(department);
    },

    async removeDepartmentMember(input: {
      workspaceId: string;
      departmentId: string;
      userId: string;
    }): Promise<{ departmentId: string; userId: string }> {
      await prisma.departmentMember.delete({
        where: {
          workspaceId_departmentId_userId: {
            workspaceId: input.workspaceId,
            departmentId: input.departmentId,
            userId: input.userId
          }
        }
      });

      return { departmentId: input.departmentId, userId: input.userId };
    },

    async upsertDepartmentChannelRule(input: {
      workspaceId: string;
      departmentId: string;
      channelId: string;
      enabled: boolean;
      priority: number;
    }): Promise<DepartmentDto> {
      await prisma.departmentChannelRule.upsert({
        where: {
          workspaceId_channelId: {
            workspaceId: input.workspaceId,
            channelId: input.channelId
          }
        },
        update: {
          departmentId: input.departmentId,
          enabled: input.enabled,
          priority: input.priority
        },
        create: {
          workspaceId: input.workspaceId,
          departmentId: input.departmentId,
          channelId: input.channelId,
          enabled: input.enabled,
          priority: input.priority
        }
      });

      const department = await prisma.department.findFirst({
        where: { workspaceId: input.workspaceId, id: input.departmentId },
        include: departmentInclude()
      });
      if (!department) {
        throw new TeamServiceError("TEAM_DEPARTMENT_NOT_FOUND", "Department not found.", 404);
      }

      return toDepartmentDto(department);
    },

    async removeDepartmentChannelRule(input: {
      workspaceId: string;
      ruleId: string;
    }): Promise<{ ruleId: string }> {
      const rule = await prisma.departmentChannelRule.delete({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.ruleId
          }
        }
      });

      return { ruleId: rule.id };
    },

    async inviteProductMember(input: {
      accountApiUrl: string;
      productKey: string;
      clerkToken: string;
      email: string;
      name?: string;
      role: ProductInviteRole;
    }): Promise<HubInviteResultDto> {
      const response = await hubFetch(
        `${normalizeAccountApiUrl(input.accountApiUrl)}/team/members/invite`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${input.clerkToken}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            email: input.email,
            ...(input.name ? { name: input.name } : {}),
            role: input.role,
            product_key: input.productKey
          })
        },
        8000
      ).catch(() => {
        throw new TeamServiceError("TEAM_HUB_INVITE_FAILED", "Não foi possível falar com o Prymeira Hub.", 502);
      });

      if (!response.ok) {
        const statusCode = response.status === 401 ? 401 : response.status === 403 ? 403 : 502;
        throw new TeamServiceError(
          "TEAM_HUB_INVITE_FAILED",
          statusCode === 403
            ? "O Prymeira Hub recusou o convite para este usuário."
            : "Não foi possível criar o convite no Prymeira Hub.",
          statusCode
        );
      }

      return parseHubInviteResult(await response.json());
    },

    async updateUserRole(input: {
      workspaceId: string;
      userId: string;
      role: UserRole;
      callerRole: UserRole;
    }): Promise<TeamUserDto> {
      const targetUser = await prisma.userProfile.findFirst({
        where: {
          workspaceId: input.workspaceId,
          id: input.userId
        }
      });

      if (!targetUser) {
        throw new TeamServiceError("TEAM_USER_NOT_FOUND", "Team user not found.", 404);
      }

      if (
        input.callerRole !== "owner" &&
        (input.role === "owner" || targetUser.role === "owner")
      ) {
        throw new TeamServiceError(
          "TEAM_OWNER_ROLE_FORBIDDEN",
          "Only owners can assign or edit owner roles.",
          403
        );
      }

      const user = await prisma.userProfile.update({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.userId
          }
        },
        data: {
          role: input.role
        }
      });

      return toUserDto(user);
    }
  };
}
