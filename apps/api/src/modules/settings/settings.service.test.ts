import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { settingsRoutes } from "./settings.routes.js";
import { createSettingsService } from "./settings.service.js";
import type { PrismaLike } from "./settings.service.js";

type MockPrisma = {
  workspaceMirror: {
    findUnique: any;
    upsert: any;
  };
  integrationConfig: {
    findUnique: any;
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

function createMockPrisma(overrides: {
  workspaceMirror?: Partial<MockPrisma["workspaceMirror"]>;
  integrationConfig?: Partial<MockPrisma["integrationConfig"]>;
  auditLog?: Partial<MockPrisma["auditLog"]>;
} = {}): MockPrisma & PrismaLike {
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
        }),
      upsert:
        overrides.workspaceMirror?.upsert ??
        vi.fn().mockImplementation(async (args) => ({
          workspaceId: "workspace_a",
          name: "Workspace A",
          plan: "pro",
          limits: args.update.limits,
          createdAt: new Date("2026-05-20T16:00:00.000Z"),
          updatedAt: new Date("2026-05-21T16:00:00.000Z")
        }))
    },
    integrationConfig: {
      findUnique: overrides.integrationConfig?.findUnique ?? vi.fn().mockResolvedValue(null),
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

async function buildSettingsApp(input: { prisma?: MockPrisma & PrismaLike; role?: "owner" | "manager" | "agent" } = {}) {
  const app = Fastify({ logger: false });
  const prisma = input.prisma ?? createMockPrisma();

  app.decorate("prisma", prisma as never);
  app.addHook("preHandler", async (request) => {
    request.talk = { workspaceId: "workspace_a", role: input.role ?? "owner" };
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
        behavior: { agentReplyWaitSeconds: 40 },
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

  it("updates agent behavior while preserving workspace limits", async () => {
    const prisma = createMockPrisma({
      workspaceMirror: {
        findUnique: vi.fn().mockResolvedValue({
          workspaceId: "workspace_a",
          name: "Workspace A",
          plan: "pro",
          limits: { existingLimit: 12 },
          createdAt: new Date(),
          updatedAt: new Date()
        })
      }
    });
    const service = createSettingsService(prisma);

    const result = await service.updateAgentBehavior({
      workspaceId: "workspace_a",
      agentReplyWaitSeconds: 10
    });

    expect(result.behavior).toEqual({ agentReplyWaitSeconds: 10 });
    expect(prisma.workspaceMirror.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: { limits: { existingLimit: 12, agentBehavior: { replyWaitSeconds: 10 } } }
    }));
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "settings.agent_behavior_updated",
        metadata: { previousWaitSeconds: 40, nextWaitSeconds: 10 }
      })
    });
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
        webhookVerifyToken: "verify-secret",
        appSecret: "app-secret"
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
        webhookVerifyToken: "verify-secret",
        appSecret: "app-secret"
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
          webhookVerifyToken: "verify-secret",
          appSecret: "app-secret"
        })
      }),
      update: expect.objectContaining({
        settings: expect.objectContaining({
          enabled: true,
          wabaId: "111",
          phoneNumberId: "222",
          accessToken: "secret-token",
          webhookVerifyToken: "verify-secret",
          appSecret: "app-secret"
        })
      })
    }));
    expect(result.integrations[0]?.settings).toMatchObject({
      enabled: true,
      wabaId: "111",
      phoneNumberId: "222",
      accessToken: "[redacted]",
      webhookVerifyToken: "[redacted]",
      appSecret: "[redacted]"
    });
  });

  it("stores OpenAI-compatible provider config and masks the API key", async () => {
    const upsert = vi.fn().mockResolvedValue({
      id: "config_openai_compatible",
      workspaceId: "local_workspace",
      provider: "openai_compatible",
      mode: "real",
      status: "configured",
      settings: {
        baseUrl: "https://api.openai.example/v1",
        apiKey: "provider-secret",
        chatModel: "gpt-4.1-mini"
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
      provider: "openai_compatible",
      mode: "real",
      settings: {
        baseUrl: "https://api.openai.example/v1",
        apiKey: "provider-secret",
        chatModel: "gpt-4.1-mini"
      }
    });

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        provider: "openai_compatible",
        mode: "real",
        settings: expect.objectContaining({
          baseUrl: "https://api.openai.example/v1",
          apiKey: "provider-secret",
          chatModel: "gpt-4.1-mini"
        })
      }),
      update: expect.objectContaining({
        settings: expect.objectContaining({
          baseUrl: "https://api.openai.example/v1",
          apiKey: "provider-secret",
          chatModel: "gpt-4.1-mini"
        })
      })
    }));
    expect(result.integrations[0]?.settings).toMatchObject({
      baseUrl: "https://api.openai.example/v1",
      apiKey: "[redacted]",
      chatModel: "gpt-4.1-mini"
    });
  });

  it("preserves existing OpenAI-compatible API key when masked or empty in updates", async () => {
    const existingOpenAiConfig = {
      id: "config_openai_compatible",
      workspaceId: "local_workspace",
      provider: "openai_compatible",
      mode: "real" as const,
      status: "configured",
      settings: {
        baseUrl: "https://old-openai.example/v1",
        apiKey: "stored-provider-key",
        chatModel: "gpt-4.1-mini"
      },
      createdAt: new Date("2026-06-02T12:00:00.000Z"),
      updatedAt: new Date("2026-06-02T12:00:00.000Z")
    };
    const upsert = vi.fn().mockImplementation(async (args) => ({
      ...existingOpenAiConfig,
      ...args.update,
      updatedAt: new Date("2026-06-02T12:05:00.000Z")
    }));

    const prisma = createMockPrisma({
      integrationConfig: {
        findMany: vi.fn().mockImplementation(async (args) =>
          "provider" in (args.where ?? {}) ? [existingOpenAiConfig] : []
        ),
        upsert
      }
    });
    const service = createSettingsService(prisma);

    await service.updateIntegrationMode({
      workspaceId: "local_workspace",
      provider: "openai_compatible",
      mode: "real",
      settings: {
        baseUrl: "https://new-openai.example/v1",
        apiKey: "[redacted]",
        chatModel: "gpt-4.1"
      }
    });

    expect(upsert).toHaveBeenLastCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        settings: expect.objectContaining({
          baseUrl: "https://new-openai.example/v1",
          apiKey: "stored-provider-key",
          chatModel: "gpt-4.1"
        })
      })
    }));

    await service.updateIntegrationMode({
      workspaceId: "local_workspace",
      provider: "openai_compatible",
      mode: "real",
      settings: {
        baseUrl: "https://newer-openai.example/v1",
        apiKey: "",
        chatModel: "gpt-4.1-nano"
      }
    });

    expect(upsert).toHaveBeenLastCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        settings: expect.objectContaining({
          baseUrl: "https://newer-openai.example/v1",
          apiKey: "stored-provider-key",
          chatModel: "gpt-4.1-nano"
        })
      })
    }));
  });

  it("validates OpenAI-compatible real mode against existing settings when no settings are supplied", async () => {
    const existingOpenAiConfig = {
      id: "config_openai_compatible",
      workspaceId: "local_workspace",
      provider: "openai_compatible",
      mode: "simulated" as const,
      status: "configured",
      settings: {
        baseUrl: "https://openai.example/v1",
        apiKey: "stored-provider-key",
        chatModel: "gpt-4.1-mini"
      },
      createdAt: new Date("2026-06-02T12:00:00.000Z"),
      updatedAt: new Date("2026-06-02T12:00:00.000Z")
    };
    const upsert = vi.fn().mockImplementation(async (args) => ({
      ...existingOpenAiConfig,
      ...args.update,
      updatedAt: new Date("2026-06-02T12:05:00.000Z")
    }));

    const prisma = createMockPrisma({
      integrationConfig: {
        findMany: vi.fn().mockImplementation(async (args) =>
          "provider" in (args.where ?? {}) ? [existingOpenAiConfig] : [existingOpenAiConfig]
        ),
        upsert
      }
    });
    const service = createSettingsService(prisma);

    const result = await service.updateIntegrationMode({
      workspaceId: "local_workspace",
      provider: "openai_compatible",
      mode: "real"
    });

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        mode: "real",
        status: "configured"
      })
    }));
    expect(result.integrations[0]?.settings).toMatchObject({
      baseUrl: "https://openai.example/v1",
      apiKey: "[redacted]",
      chatModel: "gpt-4.1-mini"
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

  it("preserves existing Meta Cloud identifiers when the integration is deactivated", async () => {
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
      mode: "simulated",
      settings: {
        enabled: false
      }
    });

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        mode: "simulated",
        settings: expect.objectContaining({
          enabled: false,
          wabaId: "111",
          phoneNumberId: "222",
          accessToken: "stored-token",
          webhookVerifyToken: "stored-verify",
          appSecret: "stored-secret"
        })
      })
    }));
  });

  it("rejects active Meta Cloud settings after merging when required fields are missing", async () => {
    const prisma = createMockPrisma({
      integrationConfig: {
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn()
      }
    });
    const service = createSettingsService(prisma);

    await expect(service.updateIntegrationMode({
      workspaceId: "local_workspace",
      provider: "meta_cloud",
      mode: "real",
      settings: {
        enabled: true
      }
    })).rejects.toMatchObject({
      code: "SETTINGS_META_CLOUD_INCOMPLETE"
    });

    expect(prisma.integrationConfig.upsert).not.toHaveBeenCalled();
  });

  it("stores Meta Cloud via Evolution config and masks the Evolution API key", async () => {
    const upsert = vi.fn().mockResolvedValue({
      id: "config_evolution_meta",
      workspaceId: "local_workspace",
      provider: "meta_cloud",
      mode: "real",
      status: "configured",
      settings: {
        enabled: true,
        connectionMode: "evolution_official",
        evolutionBaseUrl: "https://wsapi.yrdnegocios.com.br",
        evolutionApiKey: "evolution-secret",
        evolutionInstanceName: "official-instance"
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
        connectionMode: "evolution_official",
        evolutionBaseUrl: "https://wsapi.yrdnegocios.com.br",
        evolutionApiKey: "evolution-secret",
        evolutionInstanceName: "official-instance"
      }
    });

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        settings: expect.objectContaining({
          connectionMode: "evolution_official",
          evolutionApiKey: "evolution-secret",
          evolutionInstanceName: "official-instance"
        })
      })
    }));
    expect(result.integrations[0]?.settings).toMatchObject({
      enabled: true,
      connectionMode: "evolution_official",
      evolutionBaseUrl: "https://wsapi.yrdnegocios.com.br",
      evolutionApiKey: "[redacted]",
      evolutionInstanceName: "official-instance"
    });
  });

  it("preserves existing Evolution official API key when masked in updates", async () => {
    const existingMetaConfig = {
      id: "config_meta",
      workspaceId: "local_workspace",
      provider: "meta_cloud",
      mode: "real" as const,
      status: "configured",
      settings: {
        enabled: true,
        connectionMode: "evolution_official",
        evolutionBaseUrl: "https://old.example.test",
        evolutionApiKey: "stored-evolution-key",
        evolutionInstanceName: "old-instance"
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
        connectionMode: "evolution_official",
        evolutionBaseUrl: "https://new.example.test",
        evolutionApiKey: "[redacted]",
        evolutionInstanceName: "new-instance"
      }
    });

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        settings: expect.objectContaining({
          evolutionBaseUrl: "https://new.example.test",
          evolutionApiKey: "stored-evolution-key",
          evolutionInstanceName: "new-instance"
        })
      })
    }));
  });
});

describe("settings Meta Evolution template routes", () => {
  it("lists templates from the configured official Evolution instance", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        templates: [
          {
            id: "tpl_1",
            name: "boas_vindas",
            language: "pt_BR",
            status: "APPROVED",
            category: "MARKETING",
            components: [{ type: "BODY", text: "Olá {{1}}, tudo certo?" }]
          }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    globalThis.fetch = fetchMock;
    const prisma = createMockPrisma({
      integrationConfig: {
        findUnique: vi.fn().mockResolvedValue({
          id: "config_meta",
          workspaceId: "workspace_a",
          provider: "meta_cloud",
          mode: "real",
          status: "configured",
          settings: {
            enabled: true,
            connectionMode: "evolution_official",
            evolutionBaseUrl: "https://wsapi.yrdnegocios.com.br",
            evolutionApiKey: "secret-key",
            evolutionInstanceName: "prymeiradisparos1"
          },
          createdAt: new Date("2026-06-02T12:00:00.000Z"),
          updatedAt: new Date("2026-06-02T12:00:00.000Z")
        }),
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn()
      }
    });
    const { app } = await buildSettingsApp({ prisma });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/settings/meta-cloud/evolution-templates"
      });

      expect(response.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://wsapi.yrdnegocios.com.br/template/find/prymeiradisparos1",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({ apikey: "secret-key" })
        })
      );
      expect(response.json()).toEqual({
        templates: [
          {
            id: "tpl_1",
            name: "boas_vindas",
            language: "pt_BR",
            status: "APPROVED",
            category: "MARKETING",
            preview: "Olá {{1}}, tudo certo?",
            components: [{ type: "BODY", text: "Olá {{1}}, tudo certo?" }]
          }
        ],
        raw: {
          templates: [
            {
              id: "tpl_1",
              name: "boas_vindas",
              language: "pt_BR",
              status: "APPROVED",
              category: "MARKETING",
              components: [{ type: "BODY", text: "Olá {{1}}, tudo certo?" }]
            }
          ]
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }
  });

  it("rejects Evolution template listing when Meta is not active via Evolution", async () => {
    const prisma = createMockPrisma({
      integrationConfig: {
        findUnique: vi.fn().mockResolvedValue({
          id: "config_meta",
          workspaceId: "workspace_a",
          provider: "meta_cloud",
          mode: "real",
          status: "configured",
          settings: {
            enabled: true,
            connectionMode: "direct",
            wabaId: "111",
            phoneNumberId: "222",
            accessToken: "secret-token"
          },
          createdAt: new Date("2026-06-02T12:00:00.000Z"),
          updatedAt: new Date("2026-06-02T12:00:00.000Z")
        }),
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn()
      }
    });
    const { app } = await buildSettingsApp({ prisma });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/settings/meta-cloud/evolution-templates"
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        code: "META_CLOUD_NOT_CONFIGURED",
        error: "Meta Cloud via Evolution is not active for this workspace."
      });
    } finally {
      await app.close();
    }
  });
});

describe("settings routes", () => {
  it.each(["owner", "manager"] as const)("allows %s to update agent behavior", async (role) => {
    const { app } = await buildSettingsApp({ role });
    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/settings/agent-behavior",
        payload: { agentReplyWaitSeconds: 10 }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ behavior: { agentReplyWaitSeconds: 10 } });
    } finally {
      await app.close();
    }
  });

  it("forbids agents from updating agent behavior", async () => {
    const { app } = await buildSettingsApp({ role: "agent" });
    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/settings/agent-behavior",
        payload: { agentReplyWaitSeconds: 10 }
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it.each([-1, 301, 10.5, "10"])("rejects invalid reply wait %s", async (value) => {
    const { app } = await buildSettingsApp();
    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/settings/agent-behavior",
        payload: { agentReplyWaitSeconds: value }
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
  it("allows managers to update Meta Cloud settings", async () => {
    const { app } = await buildSettingsApp({ role: "manager" });

    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/settings",
        payload: {
          provider: "meta_cloud",
          mode: "real",
          settings: {
            enabled: true,
            wabaId: "111",
            phoneNumberId: "222",
            accessToken: "secret-token",
            webhookVerifyToken: "verify-secret",
            appSecret: "app-secret"
          }
        }
      });

      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("rejects incomplete active Meta Cloud settings from the API", async () => {
    const { app } = await buildSettingsApp();

    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/settings",
        payload: {
          provider: "meta_cloud",
          mode: "real",
          settings: {
            enabled: true
          }
        }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual(expect.objectContaining({
        code: "SETTINGS_META_CLOUD_INCOMPLETE"
      }));
    } finally {
      await app.close();
    }
  });

  it("rejects unknown OpenAI-compatible setting keys from the API", async () => {
    const { app } = await buildSettingsApp();

    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/settings",
        payload: {
          provider: "openai_compatible",
          mode: "simulated",
          settings: {
            api_key: "typo"
          }
        }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "Invalid settings request." });
    } finally {
      await app.close();
    }
  });

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
