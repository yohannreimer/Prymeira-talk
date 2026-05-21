import type { PrismaClient } from "@prisma/client";
import type { UserRole } from "@prymeira-talk/shared";

type DateLike = Date | string;

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

interface DepartmentRecord {
  id: string;
  workspaceId: string;
  name: string;
  routingOrder: number;
  createdAt: DateLike;
  updatedAt: DateLike;
}

type UserFindManyArgs = Parameters<PrismaClient["userProfile"]["findMany"]>[0];
type UserFindFirstArgs = Parameters<PrismaClient["userProfile"]["findFirst"]>[0];
type UserUpdateArgs = Parameters<PrismaClient["userProfile"]["update"]>[0];
type DepartmentFindManyArgs = Parameters<PrismaClient["department"]["findMany"]>[0];
type DepartmentCreateArgs = Parameters<PrismaClient["department"]["create"]>[0];

export interface PrismaLike {
  userProfile: {
    findMany(args: UserFindManyArgs): Promise<UserProfileRecord[]>;
    findFirst(args: UserFindFirstArgs): Promise<UserProfileRecord | null>;
    update(args: UserUpdateArgs): Promise<UserProfileRecord>;
  };
  department: {
    findMany(args: DepartmentFindManyArgs): Promise<DepartmentRecord[]>;
    create(args: DepartmentCreateArgs): Promise<DepartmentRecord>;
  };
}

export class TeamServiceError extends Error {
  constructor(
    public code: "TEAM_USER_NOT_FOUND" | "TEAM_OWNER_ROLE_FORBIDDEN",
    message: string
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

export interface DepartmentDto {
  id: string;
  workspaceId: string;
  name: string;
  routingOrder: number;
  createdAt: string;
  updatedAt: string;
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

function toDepartmentDto(record: DepartmentRecord): DepartmentDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    name: record.name,
    routingOrder: record.routingOrder,
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt)
  };
}

export function createTeamService(prisma: PrismaLike) {
  return {
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
        orderBy: [{ routingOrder: "asc" }, { name: "asc" }],
        take: 100
      });

      return departments.map(toDepartmentDto);
    },

    async createDepartment(input: {
      workspaceId: string;
      name: string;
      routingOrder?: number;
    }): Promise<DepartmentDto> {
      const department = await prisma.department.create({
        data: {
          workspaceId: input.workspaceId,
          name: input.name.trim(),
          routingOrder: input.routingOrder ?? 0
        }
      });

      return toDepartmentDto(department);
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
        throw new TeamServiceError("TEAM_USER_NOT_FOUND", "Team user not found.");
      }

      if (
        input.callerRole !== "owner" &&
        (input.role === "owner" || targetUser.role === "owner")
      ) {
        throw new TeamServiceError(
          "TEAM_OWNER_ROLE_FORBIDDEN",
          "Only owners can assign or edit owner roles."
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
