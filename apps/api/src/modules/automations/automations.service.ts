type DateLike = Date | string;

type AutomationStatus = "enabled" | "disabled";

interface AutomationRuleRecord {
  id: string;
  workspaceId: string;
  name: string;
  status: AutomationStatus;
  trigger: string;
  conditions: unknown;
  actions: unknown;
  createdAt: DateLike;
  updatedAt: DateLike;
}

interface AutomationRunRecord {
  id: string;
  workspaceId: string;
  ruleId: string;
  eventKey: string;
  status: string;
  input: unknown;
  result: unknown;
  createdAt: DateLike;
  updatedAt: DateLike;
}

export interface AutomationRuleDto {
  id: string;
  workspaceId: string;
  name: string;
  status: AutomationStatus;
  trigger: string;
  conditions: unknown;
  actions: unknown[];
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRunDto {
  id: string;
  workspaceId: string;
  ruleId: string;
  eventKey: string;
  status: string;
  input: unknown;
  result: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface PrismaLike {
  automationRule: {
    findMany(args: {
      where: { workspaceId: string };
      orderBy: Array<{ createdAt: "asc" }>;
    }): Promise<AutomationRuleRecord[]>;
    findFirst(args: {
      where: { workspaceId: string; id: string };
    }): Promise<AutomationRuleRecord | null>;
    create(args: {
      data: {
        workspaceId: string;
        name: string;
        status: AutomationStatus;
        trigger: string;
        conditions: unknown;
        actions: unknown[];
      };
    }): Promise<AutomationRuleRecord>;
    update(args: {
      where: { workspaceId_id: { workspaceId: string; id: string } };
      data: Partial<{
        name: string;
        status: AutomationStatus;
        trigger: string;
        conditions: unknown;
        actions: unknown[];
      }>;
    }): Promise<AutomationRuleRecord>;
  };
  automationRun: {
    findMany(args: {
      where: { workspaceId: string; ruleId: string };
      orderBy: Array<{ createdAt: "desc" }>;
      take: number;
    }): Promise<AutomationRunRecord[]>;
    upsert(args: {
      where: {
        workspaceId_ruleId_eventKey: {
          workspaceId: string;
          ruleId: string;
          eventKey: string;
        };
      };
      create: {
        workspaceId: string;
        ruleId: string;
        eventKey: string;
        status: string;
        input: unknown;
        result: unknown;
      };
      update: {
        status: string;
        input: unknown;
        result: unknown;
      };
    }): Promise<AutomationRunRecord>;
  };
}

export class AutomationsServiceError extends Error {
  constructor(
    public code: "AUTOMATION_NOT_FOUND",
    message: string
  ) {
    super(message);
  }
}

function toIsoString(value: DateLike) {
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeActions(actions: unknown): unknown[] {
  return Array.isArray(actions) ? actions : [];
}

function toRuleDto(record: AutomationRuleRecord): AutomationRuleDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    name: record.name,
    status: record.status,
    trigger: record.trigger,
    conditions: record.conditions,
    actions: normalizeActions(record.actions),
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt)
  };
}

function toRunDto(record: AutomationRunRecord): AutomationRunDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    ruleId: record.ruleId,
    eventKey: record.eventKey,
    status: record.status,
    input: record.input,
    result: record.result,
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt)
  };
}

function actionType(action: unknown, index: number) {
  if (typeof action === "object" && action !== null && "type" in action) {
    const type = (action as { type?: unknown }).type;
    if (typeof type === "string" && type.trim().length > 0) {
      return type;
    }
  }

  return `action_${index + 1}`;
}

function buildLocalActionResults(rule: AutomationRuleRecord) {
  return normalizeActions(rule.actions).map((action, index) => ({
    type: actionType(action, index),
    status: "completed",
    mode: "simulated",
    message: "Local runner simulated this action."
  }));
}

export function createAutomationsService(prisma: PrismaLike) {
  const findRuleForWorkspace = async (input: {
    workspaceId: string;
    automationId: string;
  }) => {
    const rule = await prisma.automationRule.findFirst({
      where: {
        workspaceId: input.workspaceId,
        id: input.automationId
      }
    });

    if (!rule) {
      throw new AutomationsServiceError(
        "AUTOMATION_NOT_FOUND",
        "Automation rule not found."
      );
    }

    return rule;
  };

  return {
    async listAutomations(input: { workspaceId: string }): Promise<AutomationRuleDto[]> {
      const rules = await prisma.automationRule.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: [{ createdAt: "asc" }]
      });

      return rules.map(toRuleDto);
    },

    async createAutomation(input: {
      workspaceId: string;
      name: string;
      status?: AutomationStatus;
      trigger: string;
      conditions?: unknown;
      actions?: unknown[];
    }): Promise<AutomationRuleDto> {
      const rule = await prisma.automationRule.create({
        data: {
          workspaceId: input.workspaceId,
          name: input.name.trim(),
          status: input.status ?? "disabled",
          trigger: input.trigger,
          conditions: input.conditions ?? {},
          actions: input.actions ?? []
        }
      });

      return toRuleDto(rule);
    },

    async updateAutomation(input: {
      workspaceId: string;
      automationId: string;
      data: Partial<{
        name: string;
        status: AutomationStatus;
        trigger: string;
        conditions: unknown;
        actions: unknown[];
      }>;
    }): Promise<AutomationRuleDto> {
      await findRuleForWorkspace(input);

      const rule = await prisma.automationRule.update({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.automationId
          }
        },
        data: input.data
      });

      return toRuleDto(rule);
    },

    async testAutomation(input: {
      workspaceId: string;
      automationId: string;
      eventKey?: string;
      input?: unknown;
    }): Promise<AutomationRunDto> {
      const rule = await findRuleForWorkspace(input);
      const eventKey =
        input.eventKey ?? `${rule.trigger}:manual-test:${input.automationId}`;
      const runInput = input.input ?? {
        source: "manual_test",
        trigger: rule.trigger
      };
      const result = {
        mode: "simulated",
        runner: "local",
        actionResults: buildLocalActionResults(rule)
      };

      const run = await prisma.automationRun.upsert({
        where: {
          workspaceId_ruleId_eventKey: {
            workspaceId: input.workspaceId,
            ruleId: input.automationId,
            eventKey
          }
        },
        create: {
          workspaceId: input.workspaceId,
          ruleId: input.automationId,
          eventKey,
          status: "completed",
          input: runInput,
          result
        },
        update: {
          status: "completed",
          input: runInput,
          result
        }
      });

      return toRunDto(run);
    },

    async listRuns(input: {
      workspaceId: string;
      automationId: string;
    }): Promise<AutomationRunDto[]> {
      await findRuleForWorkspace(input);

      const runs = await prisma.automationRun.findMany({
        where: {
          workspaceId: input.workspaceId,
          ruleId: input.automationId
        },
        orderBy: [{ createdAt: "desc" }],
        take: 50
      });

      return runs.map(toRunDto);
    }
  };
}
