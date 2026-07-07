import type { PrismaClient } from "@prisma/client";

type TransactionClient = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
type RoutingPrisma = Pick<
  PrismaClient | TransactionClient,
  "conversation" | "department" | "departmentChannelRule"
>;

type DepartmentMember = {
  userId: string;
  permissions: unknown;
  user?: {
    presenceState: string;
  };
};

type DepartmentRule = {
  departmentId: string;
  department: {
    id: string;
    distributionMode: "manual" | "round_robin" | "least_open";
    lastAssignedMemberId: string | null;
    members: DepartmentMember[];
  };
};

function canReceiveAssignment(member: DepartmentMember) {
  const permissions = typeof member.permissions === "object" && member.permissions !== null
    ? member.permissions as Record<string, unknown>
    : {};

  return permissions.view !== false && permissions.reply !== false;
}

function preferOnlineMembers(members: DepartmentMember[]) {
  const available = members.filter(canReceiveAssignment);
  const online = available.filter((member) => member.user?.presenceState === "online");

  return online.length > 0 ? online : available;
}

async function pickLeastOpenMember(
  prisma: RoutingPrisma,
  workspaceId: string,
  members: DepartmentMember[]
) {
  const counts = await Promise.all(
    members.map(async (member) => ({
      member,
      openCount: await prisma.conversation.count({
        where: {
          workspaceId,
          assignedUserId: member.userId,
          status: { in: ["open", "pending"] }
        }
      })
    }))
  );

  counts.sort((left, right) => left.openCount - right.openCount);
  return counts[0]?.member ?? null;
}

function pickRoundRobinMember(department: DepartmentRule["department"], members: DepartmentMember[]) {
  if (members.length === 0) return null;

  const currentIndex = members.findIndex((member) => member.userId === department.lastAssignedMemberId);
  return members[(currentIndex + 1) % members.length] ?? members[0] ?? null;
}

export async function applyInboundDepartmentRouting(
  prisma: RoutingPrisma,
  input: {
    workspaceId: string;
    conversationId: string;
    channelId: string;
  }
) {
  const conversation = await prisma.conversation.findUnique({
    where: {
      workspaceId_id: {
        workspaceId: input.workspaceId,
        id: input.conversationId
      }
    },
    select: {
      departmentId: true,
      assignedUserId: true
    }
  });

  if (!conversation || conversation.departmentId) {
    return null;
  }

  const rule = await prisma.departmentChannelRule.findFirst({
    where: {
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      enabled: true
    },
    include: {
      department: {
        include: {
          members: {
            include: {
              user: {
                select: {
                  presenceState: true
                }
              }
            },
            orderBy: { createdAt: "asc" }
          }
        }
      }
    },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }]
  }) as DepartmentRule | null;

  if (!rule) {
    return null;
  }

  const members = preferOnlineMembers(rule.department.members);
  let assignedMember: DepartmentMember | null = null;

  if (rule.department.distributionMode === "round_robin") {
    assignedMember = pickRoundRobinMember(rule.department, members);
  }

  if (rule.department.distributionMode === "least_open") {
    assignedMember = await pickLeastOpenMember(prisma, input.workspaceId, members);
  }

  await prisma.conversation.update({
    where: {
      workspaceId_id: {
        workspaceId: input.workspaceId,
        id: input.conversationId
      }
    },
    data: {
      departmentId: rule.departmentId,
      ...(assignedMember ? { assignedUserId: assignedMember.userId } : {})
    }
  });

  if (assignedMember) {
    await prisma.department.update({
      where: {
        workspaceId_id: {
          workspaceId: input.workspaceId,
          id: rule.departmentId
        }
      },
      data: {
        lastAssignedMemberId: assignedMember.userId
      }
    });
  }

  return {
    departmentId: rule.departmentId,
    assignedUserId: assignedMember?.userId ?? null
  };
}

export function supportsDepartmentRouting(prisma: unknown): prisma is RoutingPrisma {
  return (
    typeof prisma === "object" &&
    prisma !== null &&
    "departmentChannelRule" in prisma &&
    "department" in prisma &&
    "conversation" in prisma
  );
}
