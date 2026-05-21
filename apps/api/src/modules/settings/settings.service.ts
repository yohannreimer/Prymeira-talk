import type { Prisma, PrismaClient } from "@prisma/client";

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
type IntegrationConfigFindManyArgs = Parameters<PrismaClient["integrationConfig"]["findMany"]>[0];
type IntegrationConfigUpsertArgs = Parameters<PrismaClient["integrationConfig"]["upsert"]>[0];
type AuditLogCreateArgs = Parameters<PrismaClient["auditLog"]["create"]>[0];
type AuditLogFindManyArgs = Parameters<PrismaClient["auditLog"]["findMany"]>[0];

export interface PrismaLike {
  workspaceMirror: {
    findUnique(args: WorkspaceMirrorFindUniqueArgs): Promise<WorkspaceMirrorRecord | null>;
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

function toIntegrationDto(record: IntegrationConfigRecord): IntegrationConfigDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    provider: record.provider,
    mode: record.mode,
    status: record.status,
    settings: record.settings,
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
        integrations: integrations.map(toIntegrationDto)
      };
    },

    async updateIntegrationMode(input: {
      workspaceId: string;
      provider: string;
      mode: IntegrationMode;
      settings?: Prisma.InputJsonValue;
    }): Promise<SettingsDto> {
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
          settings: input.settings ?? {}
        },
        update: {
          mode: input.mode,
          status: "configured",
          ...(input.settings ? { settings: input.settings } : {})
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
        integrations: mergedIntegrations.map(toIntegrationDto)
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
