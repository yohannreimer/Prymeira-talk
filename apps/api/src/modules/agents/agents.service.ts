import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  AiAgentAllowedAction,
  AiAgentDto,
  AiKnowledgeSourceDto
} from "@prymeira-talk/shared";

type DateLike = Date | string;
type AiAgentStatus = "active" | "inactive";
type AiKnowledgeSourceType = "faq" | "text" | "file";

type AgentAllowedTagRecord = {
  tag: {
    id: string;
    name: string;
    color: string;
    useGuide: string;
    isActive: boolean;
  };
};

type AiAgentRecord = {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  status: AiAgentStatus;
  providerMode: "prymeira_managed" | "workspace_key";
  provider: string;
  model: string;
  systemPrompt: string;
  behaviorConfig: Prisma.JsonValue;
  handoffConfig: Prisma.JsonValue;
  limitsConfig: Prisma.JsonValue;
  allowedActions: Prisma.JsonValue;
  createdAt: DateLike;
  updatedAt: DateLike;
  allowedTags?: AgentAllowedTagRecord[];
};

type AiKnowledgeSourceRecord = {
  id: string;
  workspaceId: string;
  agentId: string;
  type: AiKnowledgeSourceType;
  title: string;
  content: string | null;
  fileUrl: string | null;
  fileName: string | null;
  mimeType: string | null;
  status: "ready" | "processing" | "failed";
  metadata: Prisma.JsonValue;
  createdAt: DateLike;
  updatedAt: DateLike;
};

type AgentCreateArgs = Parameters<PrismaClient["aiAgent"]["create"]>[0];
type AgentFindFirstArgs = Parameters<PrismaClient["aiAgent"]["findFirst"]>[0];
type AgentFindManyArgs = Parameters<PrismaClient["aiAgent"]["findMany"]>[0];
type AgentUpdateArgs = Parameters<PrismaClient["aiAgent"]["update"]>[0];
type KnowledgeCreateArgs = Parameters<PrismaClient["aiKnowledgeSource"]["create"]>[0];
type KnowledgeFindManyArgs = Parameters<PrismaClient["aiKnowledgeSource"]["findMany"]>[0];
type TagCountArgs = Parameters<PrismaClient["tag"]["count"]>[0];
type AgentAllowedTagCreateManyArgs = Parameters<
  PrismaClient["aiAgentAllowedTag"]["createMany"]
>[0];
type AgentAllowedTagDeleteManyArgs = Parameters<
  PrismaClient["aiAgentAllowedTag"]["deleteMany"]
>[0];

type AgentsTransactionPrismaLike = {
  aiAgent: {
    create(args: AgentCreateArgs): Promise<AiAgentRecord>;
    update(args: AgentUpdateArgs): Promise<AiAgentRecord>;
  };
  tag: {
    count(args: TagCountArgs): Promise<number>;
  };
  aiAgentAllowedTag: {
    deleteMany(args: AgentAllowedTagDeleteManyArgs): Promise<unknown>;
    createMany(args: AgentAllowedTagCreateManyArgs): Promise<unknown>;
  };
};

export interface AgentsPrismaLike {
  aiAgent: {
    findMany(args: AgentFindManyArgs): Promise<AiAgentRecord[]>;
    findFirst(args: AgentFindFirstArgs): Promise<AiAgentRecord | null>;
    create(args: AgentCreateArgs): Promise<AiAgentRecord>;
    update(args: AgentUpdateArgs): Promise<AiAgentRecord>;
  };
  aiKnowledgeSource: {
    findMany(args: KnowledgeFindManyArgs): Promise<AiKnowledgeSourceRecord[]>;
    create(args: KnowledgeCreateArgs): Promise<AiKnowledgeSourceRecord>;
  };
  tag: {
    count(args: TagCountArgs): Promise<number>;
  };
  aiAgentAllowedTag: AgentsTransactionPrismaLike["aiAgentAllowedTag"];
  $transaction<T>(callback: (tx: AgentsTransactionPrismaLike) => Promise<T>): Promise<T>;
}

export class AgentsServiceError extends Error {
  constructor(
    public readonly code: "AGENT_INVALID_CONFIG" | "AGENT_NOT_FOUND",
    message: string
  ) {
    super(message);
    this.name = "AgentsServiceError";
  }
}

const allowedActionValues = new Set<AiAgentAllowedAction>([
  "send_message",
  "add_tag",
  "remove_tag",
  "change_priority",
  "create_internal_note",
  "assign_user",
  "assign_department",
  "request_handoff"
]);

const agentInclude = {
  allowedTags: {
    include: { tag: true },
    orderBy: { tag: { name: "asc" } }
  }
} as const;

function toIsoString(value: DateLike) {
  return value instanceof Date ? value.toISOString() : value;
}

function isAllowedAction(value: unknown): value is AiAgentAllowedAction {
  return typeof value === "string" && allowedActionValues.has(value as AiAgentAllowedAction);
}

function readAllowedActions(value: Prisma.JsonValue): AiAgentAllowedAction[] {
  return Array.isArray(value) ? value.filter(isAllowedAction) : [];
}

function toRecord(value: Prisma.JsonValue): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function nullableTrim(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }

  return value?.trim() || null;
}

function toAgentDto(record: AiAgentRecord): AiAgentDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    name: record.name,
    description: record.description,
    status: record.status,
    providerMode: record.providerMode,
    provider: record.provider,
    model: record.model,
    systemPrompt: record.systemPrompt,
    behaviorConfig: toRecord(record.behaviorConfig),
    handoffConfig: toRecord(record.handoffConfig),
    limitsConfig: toRecord(record.limitsConfig),
    allowedActions: readAllowedActions(record.allowedActions),
    allowedTags:
      record.allowedTags
        ?.filter((item) => item.tag.isActive)
        .map((item) => ({
          id: item.tag.id,
          name: item.tag.name,
          color: item.tag.color,
          useGuide: item.tag.useGuide
        })) ?? [],
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt)
  };
}

function toKnowledgeSourceDto(record: AiKnowledgeSourceRecord): AiKnowledgeSourceDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    agentId: record.agentId,
    type: record.type,
    title: record.title,
    content: record.content,
    fileUrl: record.fileUrl,
    fileName: record.fileName,
    mimeType: record.mimeType,
    status: record.status,
    metadata: toRecord(record.metadata),
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt)
  };
}

function validateAgentConfig(input: {
  status?: AiAgentStatus;
  allowedActions?: AiAgentAllowedAction[];
}) {
  if (
    input.status === "active" &&
    input.allowedActions &&
    !input.allowedActions.includes("send_message")
  ) {
    throw new AgentsServiceError(
      "AGENT_INVALID_CONFIG",
      "Active agents must be allowed to send messages."
    );
  }
}

export function createAgentsService(prisma: AgentsPrismaLike) {
  function normalizeAllowedTagIds(tagIds: string[]) {
    return [...new Set(tagIds)];
  }

  async function assertAllowedTagsExist(input: {
    tx: Pick<AgentsTransactionPrismaLike, "tag">;
    workspaceId: string;
    tagIds: string[];
  }) {
    if (input.tagIds.length === 0) {
      return;
    }

    const existingActiveTags = await input.tx.tag.count({
      where: {
        workspaceId: input.workspaceId,
        id: { in: input.tagIds },
        isActive: true
      }
    });

    if (existingActiveTags !== input.tagIds.length) {
      throw new AgentsServiceError(
        "AGENT_INVALID_CONFIG",
        "Allowed tags must exist and be active."
      );
    }
  }

  async function createAllowedTags(input: {
    tx: Pick<AgentsTransactionPrismaLike, "aiAgentAllowedTag">;
    workspaceId: string;
    agentId: string;
    tagIds: string[];
  }) {
    if (input.tagIds.length === 0) {
      return;
    }

    await input.tx.aiAgentAllowedTag.createMany({
      data: input.tagIds.map((tagId) => ({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        tagId
      }))
    });
  }

  async function replaceAllowedTags(input: {
    tx: Pick<AgentsTransactionPrismaLike, "aiAgentAllowedTag">;
    workspaceId: string;
    agentId: string;
    tagIds: string[];
  }) {
    await input.tx.aiAgentAllowedTag.deleteMany({
      where: {
        workspaceId: input.workspaceId,
        agentId: input.agentId
      }
    });

    await createAllowedTags({
      tx: input.tx,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      tagIds: input.tagIds
    });
  }

  async function ensureAgent(input: { workspaceId: string; agentId: string }) {
    const agent = await prisma.aiAgent.findFirst({
      where: {
        workspaceId: input.workspaceId,
        id: input.agentId
      },
      include: agentInclude
    });

    if (!agent) {
      throw new AgentsServiceError("AGENT_NOT_FOUND", "Agent not found.");
    }

    return agent;
  }

  return {
    async listAgents(input: { workspaceId: string }): Promise<AiAgentDto[]> {
      const agents = await prisma.aiAgent.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: [{ createdAt: "asc" }],
        include: agentInclude
      });

      return agents.map(toAgentDto);
    },

    async createAgent(input: {
      workspaceId: string;
      name: string;
      description?: string | null;
      status?: AiAgentStatus;
      systemPrompt: string;
      allowedActions?: AiAgentAllowedAction[];
      allowedTagIds?: string[];
    }): Promise<AiAgentDto> {
      const allowedActions = input.allowedActions ?? ["send_message"];
      const status = input.status ?? "inactive";
      validateAgentConfig({ status, allowedActions });
      const createArgs = {
        data: {
          workspaceId: input.workspaceId,
          name: input.name.trim(),
          description: nullableTrim(input.description) ?? null,
          status,
          providerMode: "prymeira_managed",
          provider: "simulated",
          model: "prymeira-simulated",
          systemPrompt: input.systemPrompt.trim(),
          behaviorConfig: {},
          handoffConfig: {
            confidenceThreshold: 0.55
          },
          limitsConfig: {
            maxMessagesPerSession: 12
          },
          allowedActions
        }
      } satisfies AgentCreateArgs;

      if (input.allowedTagIds !== undefined) {
        const uniqueTagIds = normalizeAllowedTagIds(input.allowedTagIds);
        const agent = await prisma.$transaction(async (tx) => {
          await assertAllowedTagsExist({
            tx,
            workspaceId: input.workspaceId,
            tagIds: uniqueTagIds
          });

          const createdAgent = await tx.aiAgent.create(createArgs);
          await createAllowedTags({
            tx,
            workspaceId: input.workspaceId,
            agentId: createdAgent.id,
            tagIds: uniqueTagIds
          });

          return createdAgent;
        });

        return toAgentDto(
          await ensureAgent({
            workspaceId: input.workspaceId,
            agentId: agent.id
          })
        );
      }

      const agent = await prisma.aiAgent.create(createArgs);
      return toAgentDto(agent);
    },

    async updateAgent(input: {
      workspaceId: string;
      agentId: string;
      data: Partial<{
        name: string;
        description: string | null;
        status: AiAgentStatus;
        systemPrompt: string;
        allowedActions: AiAgentAllowedAction[];
        allowedTagIds: string[];
      }>;
    }): Promise<AiAgentDto> {
      const existingAgent = await ensureAgent(input);
      validateAgentConfig({
        status: input.data.status ?? existingAgent.status,
        allowedActions: input.data.allowedActions ?? readAllowedActions(existingAgent.allowedActions)
      });

      const description = nullableTrim(input.data.description);
      const updateArgs = {
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.agentId
          }
        },
        data: {
          ...(input.data.name !== undefined ? { name: input.data.name.trim() } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(input.data.status !== undefined ? { status: input.data.status } : {}),
          ...(input.data.systemPrompt !== undefined
            ? { systemPrompt: input.data.systemPrompt.trim() }
            : {}),
          ...(input.data.allowedActions !== undefined
            ? { allowedActions: input.data.allowedActions }
            : {})
        },
        include: agentInclude
      } satisfies AgentUpdateArgs;

      if (input.data.allowedTagIds !== undefined) {
        const uniqueTagIds = normalizeAllowedTagIds(input.data.allowedTagIds);
        await prisma.$transaction(async (tx) => {
          await assertAllowedTagsExist({
            tx,
            workspaceId: input.workspaceId,
            tagIds: uniqueTagIds
          });

          await tx.aiAgent.update(updateArgs);
          await replaceAllowedTags({
            tx,
            workspaceId: input.workspaceId,
            agentId: input.agentId,
            tagIds: uniqueTagIds
          });
        });

        return toAgentDto(await ensureAgent(input));
      }

      const agent = await prisma.aiAgent.update(updateArgs);
      return toAgentDto(agent);
    },

    async listKnowledgeSources(input: {
      workspaceId: string;
      agentId: string;
    }): Promise<AiKnowledgeSourceDto[]> {
      await ensureAgent(input);
      const sources = await prisma.aiKnowledgeSource.findMany({
        where: {
          workspaceId: input.workspaceId,
          agentId: input.agentId
        },
        orderBy: [{ createdAt: "asc" }]
      });

      return sources.map(toKnowledgeSourceDto);
    },

    async createKnowledgeSource(input: {
      workspaceId: string;
      agentId: string;
      type: AiKnowledgeSourceType;
      title: string;
      content?: string | null;
      fileUrl?: string | null;
      fileName?: string | null;
      mimeType?: string | null;
      metadata?: Prisma.InputJsonValue;
    }): Promise<AiKnowledgeSourceDto> {
      await ensureAgent(input);

      const source = await prisma.aiKnowledgeSource.create({
        data: {
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          type: input.type,
          title: input.title.trim(),
          content: nullableTrim(input.content) ?? null,
          fileUrl: nullableTrim(input.fileUrl) ?? null,
          fileName: nullableTrim(input.fileName) ?? null,
          mimeType: nullableTrim(input.mimeType) ?? null,
          status: "ready",
          metadata: input.metadata ?? {}
        }
      });

      return toKnowledgeSourceDto(source);
    }
  };
}
