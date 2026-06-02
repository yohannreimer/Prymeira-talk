import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { settingsRoutes } from "./settings.routes.js";
import { createSettingsService } from "./settings.service.js";
import type { PrismaLike } from "./settings.service.js";

type MockPrisma = {
  workspaceMirror: {
    findUnique: any;
  };
  integrationConfig: {
    findMany: any;
    upsert: any;
  };
  auditLog: {
    create: any;
    findMany: any;
  };
};

const configId = "00000000-0000-4000-8000-000000000601";
const auditLogId = "00000000-0000-4000-8000-000000000602";

const baseConfig = {
  id: configId,
  workspaceId: "workspace_a",
  provider: "atomic_crm",
  mode: "simulated" as const,
  status: "configured",
  settings: { pipelineId: "pipe_demo" },
  createdAt: new Date("2026-05-21T16:00:00.000Z"),
  updatedAt: new Date("2026-05-21T16:00:00.000Z")
};

const baseAuditLog = {
  id: auditLogId,
  workspaceId: "workspace_a",
  actorUserId: null,
  action: "settings.integration_mode_updated",
  targetType: "integration_config",
  targetId: "atomic_crm",
  metadata: { provider: "atomic_crm", mode: "real" },
  createdAt: new Date("2026-05-21T16:05:00.000Z")
};

function createMockPrisma(overrides: Partial<MockPrisma> = {}): MockPrisma & PrismaLike {
  return {
    workspaceMirror: {
      findUnique:
        overrides.workspaceMirror?.findUnique ??
        vi.fn().mockResolvedValue({
          workspaceId: "workspace_a",
          name: "Workspace A",
          plan: "pro",
          limits: { seats: 12 },
          createdAt: new Date("2026-05-20T16:00:00.000Z"),
          updatedAt: new Date("2026-05-21T16:00:00.000Z")
        })
    },
    integrationConfig: {
      findMany: overrides.integrationConfig?.findMany ?? vi.fn().mockResolvedValue([baseConfig]),
      upsert:
        overrides.integrationConfig?.upsert ??
        vi.fn().mockImplementation(async (args) => ({
          ...baseConfig,
          ...args.create,
          ...args.update
        }))
    },
    auditLog: {
      create:
        overrides.auditLog?.create ??
        vi.fn().mockImplementation(async (args) => ({
          ...baseAuditLog,
          ...args.data
        })),
      findMany: overrides.auditLog?.findMany ?? vi.fn().mockResolvedValue([baseAuditLog])
    }
  } as MockPrisma & PrismaLike;
}

async function buildSettingsApp(input: { prisma?: MockPrisma & PrismaLike } = {}) {
  const app = Fastify({ logger: false });
  const prisma = input.prisma ?? createMockPrisma();

  app.decorate("prisma", prisma as never);
  app.addHook("preHandler", async (request) => {
    request.talk = { workspaceId: "workspace_a", role: "owner" };
  });
  await app.register(settingsRoutes);

  return { app, prisma };
}

describe("settings service", () => {
  it("gets workspace settings", async () => {
    const prisma = createMockPrisma();
    const service = createSettingsService(prisma);

    const settings = await service.getSettings({ workspaceId: "workspace_a" });

    expect(settings).toEqual(
      expect.objectContaining({
        workspace: expect.objectContaining({
          workspaceId: "workspace_a",
          name: "Workspace A",
          plan: "pro"
        }),
        integrations: [
          expect.objectContaining({
            provider: "atomic_crm",
            mode: "simulated"
          })
        ]
      })
    );
  });

  it("updates integration mode and writes an audit log entry", async () => {
    const prisma = createMockPrisma();
    const service = createSettingsService(prisma);

    const settings = await service.updateIntegrationMode({
      workspaceId: "workspace_a",
      provider: "atomic_crm",
      mode: "real"
    });

    expect(settings.integrations[0]).toEqual(
      expect.objectContaining({
        provider: "atomic_crm",
        mode: "real"
      })
    );
    expect(prisma.integrationConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId_provider: {
            workspaceId: "workspace_a",
            provider: "atomic_crm"
          }
        },
        update: expect.objectContaining({
          mode: "real",
          status: "configured"
        })
      })
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace_a",
        actorUserId: null,
        action: "settings.integration_mode_updated",
        targetType: "integration_config",
        targetId: "atomic_crm",
        metadata: {
          provider: "atomic_crm",
          mode: "real"
        }
      }
    });
  });

  it("stores Meta Cloud config and masks secrets in the returned settings", async () => {
    const upsert = vi.fn().mockResolvedValue({
      id: "config_1",
      workspaceId: "local_workspace",
      provider: "meta_cloud",
      mode: "real",
      status: "configured",
      settings: {
        enabled: true,
        wabaId: "111",
        phoneNumberId: "222",
        accessToken: "secret-token",
        webhookVerifyToken: "verify-secret"
      },
      createdAt: new Date("2026-06-02T12:00:00.000Z"),
      updatedAt: new Date("2026-06-02T12:00:00.000Z")
    });

    const prisma = createMockPrisma({
      integrationConfig: {
        findMany: vi.fn().mockResolvedValue([]),
        upsert
      }
    });
    const service = createSettingsService(prisma);

    const result = await service.updateIntegrationMode({
      workspaceId: "local_workspace",
      provider: "meta_cloud",
      mode: "real",
      settings: {
        enabled: true,
        wabaId: "111",
        phoneNumberId: "222",
        accessToken: "secret-token",
        webhookVerifyToken: "verify-secret"
      }
    });

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        provider: "meta_cloud",
        mode: "real",
        settings: expect.objectContaining({
          enabled: true,
          wabaId: "111",
          phoneNumberId: "222",
          accessToken: "secret-token",
          webhookVerifyToken: "verify-secret"
        })
      }),
      update: expect.objectContaining({
        settings: expect.objectContaining({
          enabled: true,
          wabaId: "111",
          phoneNumberId: "222",
          accessToken: "secret-token",
          webhookVerifyToken: "verify-secret"
        })
      })
    }));
    expect(result.integrations[0]?.settings).toMatchObject({
      enabled: true,
      wabaId: "111",
      phoneNumberId: "222",
      accessToken: "[redacted]",
      webhookVerifyToken: "[redacted]"
    });
  });

  it("preserves existing Meta Cloud secrets when masked or omitted in updates", async () => {
    const existingMetaConfig = {
      id: "config_meta",
      workspaceId: "local_workspace",
      provider: "meta_cloud",
      mode: "real" as const,
      status: "configured",
      settings: {
        enabled: true,
        wabaId: "111",
        phoneNumberId: "222",
        accessToken: "stored-token",
        webhookVerifyToken: "stored-verify",
        appSecret: "stored-secret"
      },
      createdAt: new Date("2026-06-02T12:00:00.000Z"),
      updatedAt: new Date("2026-06-02T12:00:00.000Z")
    };
    const upsert = vi.fn().mockImplementation(async (args) => ({
      ...existingMetaConfig,
      ...args.update,
      updatedAt: new Date("2026-06-02T12:05:00.000Z")
    }));

    const prisma = createMockPrisma({
      integrationConfig: {
        findMany: vi.fn().mockImplementation(async (args) =>
          "provider" in (args.where ?? {}) ? [existingMetaConfig] : []
        ),
        upsert
      }
    });
    const service = createSettingsService(prisma);

    await service.updateIntegrationMode({
      workspaceId: "local_workspace",
      provider: "meta_cloud",
      mode: "real",
      settings: {
        enabled: true,
        wabaId: "333",
        phoneNumberId: "444",
        accessToken: "[redacted]",
        webhookVerifyToken: "",
        appSecret: "new-secret"
      }
    });

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        settings: expect.objectContaining({
          enabled: true,
          wabaId: "333",
          phoneNumberId: "444",
          accessToken: "stored-token",
          webhookVerifyToken: "stored-verify",
          appSecret: "new-secret"
        })
      })
    }));
  });
});

describe("settings routes", () => {
  it("returns audit log entries from GET /settings/audit-log", async () => {
    const { app } = await buildSettingsApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/settings/audit-log"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        expect.objectContaining({
          id: auditLogId,
          workspaceId: "workspace_a",
          action: "settings.integration_mode_updated"
        })
      ]);
    } finally {
      await app.close();
    }
  });
});
