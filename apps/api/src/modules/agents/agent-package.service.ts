import type { Prisma } from "@prisma/client";
import {
  agentPackageSchema,
  agentPackageVariableSchema,
  type AgentPackage,
  type AgentKnowledgeTaxonomyEntry,
  type AiAgentDto
} from "@prymeira-talk/shared";
import { readKnowledgeTaxonomy } from "./knowledge-taxonomy.js";

type DateLike = Date | string;

type AgentRecord = {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  status: "active" | "inactive";
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
};

type KnowledgeRecord = {
  id: string;
  workspaceId: string;
  agentId: string;
  type: "faq" | "text" | "file";
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

type TransactionClient = {
  aiAgent: {
    create(args: { data: Record<string, unknown> }): Promise<AgentRecord>;
  };
  aiKnowledgeSource: {
    create(args: { data: Record<string, unknown> }): Promise<KnowledgeRecord>;
  };
};

export interface AgentPackagePrismaLike {
  aiAgent: {
    findFirst(args: unknown): Promise<AgentRecord | null>;
  };
  aiKnowledgeSource: {
    findMany(args: unknown): Promise<KnowledgeRecord[]>;
  };
  $transaction<T>(callback: (tx: TransactionClient) => Promise<T>): Promise<T>;
}

export class AgentPackageServiceError extends Error {
  constructor(
    public readonly code:
      | "PACKAGE_INVALID"
      | "PACKAGE_VARIABLE_MISSING"
      | "AGENT_NOT_FOUND",
    message: string
  ) {
    super(message);
    this.name = "AgentPackageServiceError";
  }
}

export function createAgentPackageService(prisma: AgentPackagePrismaLike) {
  return {
    validatePackage(input: unknown) {
      return parsePackage(input);
    },

    async importPackage(input: {
      workspaceId: string;
      package: unknown;
      variableValues: Record<string, string>;
    }): Promise<{ agent: AiAgentDto; knowledgeCount: number }> {
      const agentPackage = parsePackage(input.package);
      assertKnownTemplateVariables(agentPackage);
      const variables = resolveVariables(agentPackage, input.variableValues);

      return prisma.$transaction(async (tx) => {
        const agent = await tx.aiAgent.create({
          data: {
            workspaceId: input.workspaceId,
            name: renderTemplate(agentPackage.agent.name, variables),
            description: agentPackage.agent.description,
            status: "inactive",
            providerMode: "prymeira_managed",
            provider: "simulated",
            model: "prymeira-simulated",
            systemPrompt: renderTemplate(agentPackage.agent.systemPrompt, variables),
            behaviorConfig: {
              ...agentPackage.agent.behavior,
              packageMetadata: agentPackage.metadata,
              packageVariables: agentPackage.variables,
              packageAgentNameTemplate: agentPackage.agent.name,
              packagePromptTemplate: agentPackage.agent.systemPrompt,
              qualification: agentPackage.agent.qualification,
              knowledgeTaxonomy: agentPackage.agent.knowledgeTaxonomy,
              followup: agentPackage.agent.followup,
              deploymentVariables: variables
            },
            handoffConfig: agentPackage.agent.handoff,
            limitsConfig: agentPackage.agent.limits,
            allowedActions: agentPackage.agent.allowedActions
          }
        });

        for (const source of agentPackage.knowledge) {
          await tx.aiKnowledgeSource.create({
            data: {
              workspaceId: input.workspaceId,
              agentId: agent.id,
              type: source.type,
              title: source.title,
              content: renderTemplate(source.content, variables),
              fileUrl: null,
              fileName: null,
              mimeType: null,
              status: "ready",
              metadata: {
                category: source.category,
                aliases: source.aliases,
                approvalStatus: source.approvalStatus,
                source: source.source,
                approvedBy: source.approvedBy,
                approvedAt: source.approvedAt,
                validUntil: source.validUntil,
                packageKey: agentPackage.metadata.key,
                packageSchemaVersion: agentPackage.schemaVersion,
                packageKnowledgeKey: source.key,
                packageContentTemplate: source.content
              }
            }
          });
        }

        return {
          agent: toAgentDto(agent),
          knowledgeCount: agentPackage.knowledge.length
        };
      });
    },

    async exportPackage(input: {
      workspaceId: string;
      agentId: string;
    }): Promise<AgentPackage> {
      const agent = await prisma.aiAgent.findFirst({
        where: { workspaceId: input.workspaceId, id: input.agentId }
      });
      if (!agent) {
        throw new AgentPackageServiceError("AGENT_NOT_FOUND", "Agent not found.");
      }

      const sources = await prisma.aiKnowledgeSource.findMany({
        where: {
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          status: "ready"
        },
        orderBy: [{ createdAt: "asc" }]
      });
      const behaviorConfig = toRecord(agent.behaviorConfig);
      const sourceCategories = sources
        .map((source) => readString(toRecord(source.metadata).category))
        .filter((category): category is string => Boolean(category));
      const taxonomy = ensureSourceCategories(
        readKnowledgeTaxonomy(behaviorConfig),
        sourceCategories
      );
      const packageMetadata = readPackageMetadata(behaviorConfig.packageMetadata, agent);
      const variables = readPackageVariables(behaviorConfig.packageVariables);
      const qualification = isRecord(behaviorConfig.qualification)
        ? behaviorConfig.qualification
        : { completionStage: "handoff", fields: [] };
      const followup = isRecord(behaviorConfig.followup)
        ? behaviorConfig.followup
        : {
            timeZone: "America/Sao_Paulo",
            businessDays: [1, 2, 3, 4, 5],
            businessHours: { start: "08:00", end: "18:00" },
            steps: [],
            closeAfterBusinessMinutes: 0
          };

      const exported = {
        schemaVersion: 1,
        kind: "prymeira.agent-package",
        metadata: packageMetadata,
        variables,
        agent: {
          name:
            readString(behaviorConfig.packageAgentNameTemplate) ?? agent.name,
          description: agent.description,
          systemPrompt:
            readString(behaviorConfig.packagePromptTemplate) ?? agent.systemPrompt,
          qualification,
          knowledgeTaxonomy: taxonomy,
          behavior: omitReservedBehaviorConfig(behaviorConfig),
          handoff: toRecord(agent.handoffConfig),
          limits: toRecord(agent.limitsConfig),
          followup,
          allowedActions: Array.isArray(agent.allowedActions)
            ? agent.allowedActions
            : []
        },
        knowledge: sources
          .filter((source) => Boolean(source.content?.trim()))
          .map((source, index) => toPackageKnowledge(source, index, taxonomy))
      };

      try {
        return agentPackageSchema.parse(exported);
      } catch {
        throw new AgentPackageServiceError(
          "PACKAGE_INVALID",
          "The saved agent cannot be exported as a valid package."
        );
      }
    }
  };
}

function parsePackage(value: unknown): AgentPackage {
  const parsed = agentPackageSchema.safeParse(value);
  if (!parsed.success) {
    throw new AgentPackageServiceError("PACKAGE_INVALID", "Invalid agent package.");
  }
  return parsed.data;
}

function resolveVariables(agentPackage: AgentPackage, values: Record<string, string>) {
  const resolved: Record<string, string> = {};
  for (const variable of agentPackage.variables) {
    const value = values[variable.key]?.trim() || variable.defaultValue?.trim() || "";
    if (variable.required && !value) {
      throw new AgentPackageServiceError(
        "PACKAGE_VARIABLE_MISSING",
        `Missing required package variable: ${variable.key}`
      );
    }
    resolved[variable.key] = value;
  }
  return resolved;
}

function assertKnownTemplateVariables(agentPackage: AgentPackage) {
  const knownVariables = new Set(agentPackage.variables.map((variable) => variable.key));
  const templateValues = [
    agentPackage.agent.name,
    agentPackage.agent.systemPrompt,
    ...agentPackage.knowledge.map((source) => source.content)
  ];

  for (const value of templateValues) {
    for (const key of findTemplateVariables(value)) {
      if (!knownVariables.has(key)) {
        throw new AgentPackageServiceError(
          "PACKAGE_INVALID",
          `Unknown package variable: ${key}`
        );
      }
    }
  }
}

function findTemplateVariables(value: string) {
  return Array.from(value.matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g), (match) => match[1]);
}

function renderTemplate(value: string, variables: Record<string, string>) {
  return value.replace(
    /\{\{([a-z][a-z0-9_]*)\}\}/g,
    (_match, key: string) => variables[key] ?? ""
  );
}

function toAgentDto(record: AgentRecord): AiAgentDto {
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
    allowedActions: Array.isArray(record.allowedActions)
      ? (record.allowedActions as AiAgentDto["allowedActions"])
      : [],
    allowedTags: [],
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt)
  };
}

function toPackageKnowledge(
  source: KnowledgeRecord,
  index: number,
  taxonomy: AgentKnowledgeTaxonomyEntry[]
) {
  const metadata = toRecord(source.metadata);
  const rawCategory = readString(metadata.category) ?? "outro";
  const category = taxonomy.some((entry) => entry.key === rawCategory)
    ? rawCategory
    : normalizeTaxonomyKey(rawCategory);

  return {
    key:
      readString(metadata.packageKnowledgeKey) ??
      uniqueFallbackKey(source.title, index),
    type: source.type,
    title: source.title,
    category,
    content:
      readString(metadata.packageContentTemplate) ?? source.content ?? "",
    approvalStatus:
      metadata.approvalStatus === "behavioral" ? "behavioral" : "confirmed",
    source: readString(metadata.source) ?? "Prymeira Talk knowledge source",
    approvedBy: readString(metadata.approvedBy) ?? "Workspace manager",
    approvedAt:
      readString(metadata.approvedAt) ?? toIsoString(source.updatedAt),
    validUntil: readString(metadata.validUntil),
    aliases: readStringList(metadata.aliases)
  } as const;
}

function ensureSourceCategories(
  taxonomy: AgentKnowledgeTaxonomyEntry[],
  sourceCategories: string[]
) {
  const result = [...taxonomy];
  for (const rawCategory of sourceCategories) {
    const key = normalizeTaxonomyKey(rawCategory);
    if (!result.some((entry) => entry.key === key)) {
      result.push({
        key,
        label: rawCategory,
        aliases: [rawCategory],
        requiresSource: false
      });
    }
  }
  return result;
}

function readPackageMetadata(value: unknown, agent: AgentRecord) {
  if (isRecord(value)) {
    return value;
  }

  return {
    key: toPackageKey(agent.name),
    name: agent.name,
    companyName: "Workspace",
    industry: "general",
    language: "pt-BR",
    description: agent.description ?? "Portable Prymeira Talk agent package."
  };
}

function readPackageVariables(value: unknown) {
  const parsed = agentPackageVariableSchema.array().safeParse(value);
  return parsed.success ? parsed.data : [];
}

function omitReservedBehaviorConfig(value: Record<string, unknown>) {
  const {
    packageMetadata: _packageMetadata,
    packageVariables: _packageVariables,
    packageAgentNameTemplate: _packageAgentNameTemplate,
    packagePromptTemplate: _packagePromptTemplate,
    qualification: _qualification,
    knowledgeTaxonomy: _knowledgeTaxonomy,
    followup: _followup,
    deploymentVariables: _deploymentVariables,
    ...behavior
  } = value;
  return behavior;
}

function uniqueFallbackKey(title: string, index: number) {
  return `${normalizeTaxonomyKey(title)}_${index + 1}`.slice(0, 80);
}

function normalizeTaxonomyKey(value: string) {
  const normalized = value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(normalized) ? normalized.slice(0, 80) : `category_${normalized}`.slice(0, 80);
}

function toPackageKey(value: string) {
  const normalized = value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[a-z]/.test(normalized) ? normalized.slice(0, 120) : `agent-${normalized}`.slice(0, 120);
}

function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function toIsoString(value: DateLike) {
  return value instanceof Date ? value.toISOString() : value;
}
