import type { Prisma, PrismaClient } from "@prisma/client";
import {
  readAgentBehaviorSettings,
  writeAgentBehaviorSettings,
  type AgentBehaviorSettings
} from "./agent-behavior-settings.js";

type DateLike = Date | string;
type IntegrationMode = "simulated" | "real";

interface WorkspaceMirrorRecord {
  workspaceId: string;
  name: string | null;
  plan: string | null;
  limits: Prisma.JsonValue;
  createdAt: DateLike;
  updatedAt: DateLike;
}

interface IntegrationConfigRecord {
  id: string;
  workspaceId: string;
  provider: string;
  mode: IntegrationMode;
  status: string;
  settings: Prisma.JsonValue;
  createdAt: DateLike;
  updatedAt: DateLike;
}

interface AuditLogRecord {
  id: string;
  workspaceId: string;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Prisma.JsonValue;
  createdAt: DateLike;
}

type WorkspaceMirrorFindUniqueArgs = Parameters<PrismaClient["workspaceMirror"]["findUnique"]>[0];
type WorkspaceMirrorUpsertArgs = Parameters<PrismaClient["workspaceMirror"]["upsert"]>[0];
type IntegrationConfigFindManyArgs = Parameters<PrismaClient["integrationConfig"]["findMany"]>[0];
type IntegrationConfigUpsertArgs = Parameters<PrismaClient["integrationConfig"]["upsert"]>[0];
type AuditLogCreateArgs = Parameters<PrismaClient["auditLog"]["create"]>[0];
type AuditLogFindManyArgs = Parameters<PrismaClient["auditLog"]["findMany"]>[0];

export interface PrismaLike {
  workspaceMirror: {
    findUnique(args: WorkspaceMirrorFindUniqueArgs): Promise<WorkspaceMirrorRecord | null>;
    upsert(args: WorkspaceMirrorUpsertArgs): Promise<WorkspaceMirrorRecord>;
  };
  integrationConfig: {
    findMany(args: IntegrationConfigFindManyArgs): Promise<IntegrationConfigRecord[]>;
    upsert(args: IntegrationConfigUpsertArgs): Promise<IntegrationConfigRecord>;
  };
  auditLog: {
    create(args: AuditLogCreateArgs): Promise<AuditLogRecord>;
    findMany(args: AuditLogFindManyArgs): Promise<AuditLogRecord[]>;
  };
}

export interface WorkspaceSettingsDto {
  workspaceId: string;
  name: string | null;
  plan: string | null;
  limits: Prisma.JsonValue;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface IntegrationConfigDto {
  id: string;
  workspaceId: string;
  provider: string;
  mode: IntegrationMode;
  status: string;
  settings: Prisma.JsonValue;
  createdAt: string;
  updatedAt: string;
}

export interface SettingsDto {
  workspace: WorkspaceSettingsDto;
  behavior: AgentBehaviorSettings;
  integrations: IntegrationConfigDto[];
}

export interface AuditLogDto {
  id: string;
  workspaceId: string;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Prisma.JsonValue;
  createdAt: string;
}

function toIsoString(value: DateLike) {
  return value instanceof Date ? value.toISOString() : value;
}

function toWorkspaceDto(workspaceId: string, record: WorkspaceMirrorRecord | null): WorkspaceSettingsDto {
  return {
    workspaceId,
    name: record?.name ?? null,
    plan: record?.plan ?? null,
    limits: record?.limits ?? {},
    createdAt: record ? toIsoString(record.createdAt) : null,
    updatedAt: record ? toIsoString(record.updatedAt) : null
  };
}

const SECRET_SETTING_KEYS = new Set([
  "accessToken",
  "webhookVerifyToken",
  "appSecret",
  "evolutionApiKey",
  "apiKey",
  "token",
  "secret"
]);

function maskIntegrationSettings(settings: Prisma.JsonValue): Prisma.JsonValue {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return settings;
  }

  return Object.fromEntries(
    Object.entries(settings as Record<string, unknown>).map(([key, value]) => [
      key,
      SECRET_SETTING_KEYS.has(key) && typeof value === "string" && value.length > 0
        ? "[redacted]"
        : value
    ])
  ) as Prisma.JsonObject;
}

function toIntegrationDto(record: IntegrationConfigRecord): IntegrationConfigDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    provider: record.provider,
    mode: record.mode,
    status: record.status,
    settings: maskIntegrationSettings(record.settings),
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt)
  };
}

function toAuditLogDto(record: AuditLogRecord): AuditLogDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    actorUserId: record.actorUserId,
    action: record.action,
    targetType: record.targetType,
    targetId: record.targetId,
    metadata: record.metadata,
    createdAt: toIsoString(record.createdAt)
  };
}

function isSettingsRecord(settings: Prisma.JsonValue | Prisma.InputJsonValue | undefined) {
  return Boolean(settings) && typeof settings === "object" && !Array.isArray(settings);
}

function shouldPreserveSecretValue(key: string, value: unknown) {
  return SECRET_SETTING_KEYS.has(key) && (value === "[redacted]" || value === "");
}

function getStringSetting(settings: Record<string, unknown>, key: string) {
  const value = settings[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export class SettingsValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "SettingsValidationError";
  }
}

function mergeIntegrationSettings(
  provider: string,
  previousSettings: Prisma.JsonValue | undefined,
  nextSettings: Prisma.InputJsonValue | undefined
): Prisma.InputJsonValue | undefined {
  if (!isSettingsRecord(nextSettings)) {
    return nextSettings;
  }

  const previous = isSettingsRecord(previousSettings) ? previousSettings as Record<string, unknown> : {};
  const incoming = nextSettings as Record<string, unknown>;
  const shouldMergeExisting = provider === "meta_cloud" || provider === "openai_compatible";
  const merged = shouldMergeExisting
    ? { ...previous, ...incoming }
    : { ...incoming };

  for (const key of SECRET_SETTING_KEYS) {
    if (!(key in incoming) || shouldPreserveSecretValue(key, incoming[key])) {
      const previousValue = previous[key];

      if (typeof previousValue === "string" && previousValue.length > 0) {
        merged[key] = previousValue;
      } else if (key in incoming && shouldPreserveSecretValue(key, incoming[key])) {
        delete merged[key];
      }
    }
  }

  return merged as Prisma.InputJsonObject;
}

function assertMetaCloudSettingsConfigured(
  provider: string,
  mode: IntegrationMode,
  settings: Prisma.InputJsonValue | undefined
) {
  if (provider !== "meta_cloud" || mode !== "real" || !isSettingsRecord(settings)) {
    return;
  }

  const record = settings as Record<string, unknown>;
  if (record.enabled !== true) {
    return;
  }

  const connectionMode = record.connectionMode === "evolution_official"
    ? "evolution_official"
    : "direct";
  const requiredKeys = connectionMode === "evolution_official"
    ? [
        "evolutionBaseUrl",
        "evolutionApiKey",
        "evolutionInstanceName"
      ]
    : [
        "wabaId",
        "phoneNumberId",
        "accessToken",
        "webhookVerifyToken",
        "appSecret"
      ];
  const missingKey = requiredKeys.find((key) => !getStringSetting(record, key));

  if (missingKey) {
    throw new SettingsValidationError(
      "SETTINGS_META_CLOUD_INCOMPLETE",
      `Meta Cloud setting ${missingKey} is required when the integration is active.`
    );
  }
}

function assertOpenAiCompatibleSettingsConfigured(
  provider: string,
  mode: IntegrationMode,
  settings: Prisma.InputJsonValue | undefined
) {
  if (provider !== "openai_compatible" || mode !== "real") {
    return;
  }

  const record = isSettingsRecord(settings) ? settings as Record<string, unknown> : {};
  const requiredKeys = ["baseUrl", "apiKey", "chatModel"];
  const missingKey = requiredKeys.find((key) => !getStringSetting(record, key));

  if (missingKey) {
    throw new SettingsValidationError(
      "SETTINGS_OPENAI_COMPATIBLE_INCOMPLETE",
      `OpenAI-compatible provider setting ${missingKey} is required when the integration is active.`
    );
  }
}

export function createSettingsService(prisma: PrismaLike) {
  const readSettingsParts = async (workspaceId: string) => {
    const [workspace, integrations] = await Promise.all([
      prisma.workspaceMirror.findUnique({
        where: { workspaceId }
      }),
      prisma.integrationConfig.findMany({
        where: { workspaceId },
        orderBy: [{ provider: "asc" }]
      })
    ]);

    return { workspace, integrations };
  };

  return {
    async getSettings(input: { workspaceId: string }): Promise<SettingsDto> {
      const { workspace, integrations } = await readSettingsParts(input.workspaceId);

      return {
        workspace: toWorkspaceDto(input.workspaceId, workspace),
        behavior: readAgentBehaviorSettings(workspace?.limits),
        integrations: integrations.map(toIntegrationDto)
      };
    },

    async updateIntegrationMode(input: {
      workspaceId: string;
      provider: string;
      mode: IntegrationMode;
      settings?: Prisma.InputJsonValue;
    }): Promise<SettingsDto> {
      const shouldLoadExistingConfig = input.settings !== undefined ||
        (input.provider === "openai_compatible" && input.mode === "real");
      const existingConfig = shouldLoadExistingConfig
        ? (await prisma.integrationConfig.findMany({
            where: {
              workspaceId: input.workspaceId,
              provider: input.provider
            },
            take: 1
          }))[0]
        : undefined;
      const settings = mergeIntegrationSettings(input.provider, existingConfig?.settings, input.settings);
      const settingsForValidation = (settings ?? existingConfig?.settings) as Prisma.InputJsonValue | undefined;
      assertMetaCloudSettingsConfigured(input.provider, input.mode, settingsForValidation);
      assertOpenAiCompatibleSettingsConfigured(input.provider, input.mode, settingsForValidation);
      const updatedConfig = await prisma.integrationConfig.upsert({
        where: {
          workspaceId_provider: {
            workspaceId: input.workspaceId,
            provider: input.provider
          }
        },
        create: {
          workspaceId: input.workspaceId,
          provider: input.provider,
          mode: input.mode,
          status: "configured",
          settings: settings ?? {}
        },
        update: {
          mode: input.mode,
          status: "configured",
          ...(settings ? { settings } : {})
        }
      });

      await prisma.auditLog.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: null,
          action: "settings.integration_mode_updated",
          targetType: "integration_config",
          targetId: input.provider,
          metadata: {
            provider: input.provider,
            mode: input.mode
          }
        }
      });

      const { workspace, integrations } = await readSettingsParts(input.workspaceId);
      const mergedIntegrations = integrations.some((config) => config.provider === updatedConfig.provider)
        ? integrations.map((config) =>
            config.provider === updatedConfig.provider ? updatedConfig : config
          )
        : [updatedConfig, ...integrations];

      return {
        workspace: toWorkspaceDto(input.workspaceId, workspace),
        behavior: readAgentBehaviorSettings(workspace?.limits),
        integrations: mergedIntegrations.map(toIntegrationDto)
      };
    },

    async updateAgentBehavior(input: {
      workspaceId: string;
      agentReplyWaitSeconds: number;
    }): Promise<SettingsDto> {
      const current = await prisma.workspaceMirror.findUnique({
        where: { workspaceId: input.workspaceId }
      });
      const previous = readAgentBehaviorSettings(current?.limits);
      const nextLimits = writeAgentBehaviorSettings(current?.limits, {
        agentReplyWaitSeconds: input.agentReplyWaitSeconds
      }) as Prisma.InputJsonObject;
      const workspace = await prisma.workspaceMirror.upsert({
        where: { workspaceId: input.workspaceId },
        create: {
          workspaceId: input.workspaceId,
          limits: nextLimits
        },
        update: {
          limits: nextLimits
        }
      });

      await prisma.auditLog.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: null,
          action: "settings.agent_behavior_updated",
          targetType: "workspace_mirror",
          targetId: input.workspaceId,
          metadata: {
            previousWaitSeconds: previous.agentReplyWaitSeconds,
            nextWaitSeconds: input.agentReplyWaitSeconds
          }
        }
      });

      const integrations = await prisma.integrationConfig.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: [{ provider: "asc" }]
      });
      return {
        workspace: toWorkspaceDto(input.workspaceId, workspace),
        behavior: readAgentBehaviorSettings(workspace.limits),
        integrations: integrations.map(toIntegrationDto)
      };
    },

    async listAuditLog(input: { workspaceId: string }): Promise<AuditLogDto[]> {
      const entries = await prisma.auditLog.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: [{ createdAt: "desc" }],
        take: 100
      });

      return entries.map(toAuditLogDto);
    }
  };
}
