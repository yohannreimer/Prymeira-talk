import Fastify from "fastify";
import { channelSchema, realtimeEventSchema } from "@prymeira-talk/shared";
import { describe, expect, it, vi } from "vitest";
import { ChannelsServiceError, createChannelsService } from "./channels.service.js";
import { EvolutionClientError } from "../evolution/evolution.client.js";
import type { PrismaLike } from "./channels.service.js";
import { channelsRoutes } from "./channels.routes.js";

type MockPrisma = {
  channel: {
    findMany: any;
    findFirst: any;
    create: any;
    update: any;
    delete: any;
  };
  integrationConfig: {
    findUnique: any;
  };
  contact: {
    upsert: any;
  };
  conversation: {
    upsert: any;
    update: any;
  };
  message: {
    create: any;
  };
};

const channelId = "00000000-0000-4000-8000-000000000001";
const contactId = "00000000-0000-4000-8000-000000000002";
const conversationId = "00000000-0000-4000-8000-000000000003";

const baseChannel = {
  id: channelId,
  workspaceId: "workspace_a",
  provider: "evolution" as const,
  providerKey: "demo-evolution",
  phoneNumber: "+55 47 99999-0000",
  displayName: "WhatsApp Comercial",
  status: "disconnected" as const,
  encryptedConfig: {},
  createdAt: new Date("2026-05-20T10:00:00.000Z"),
  updatedAt: new Date("2026-05-20T10:00:00.000Z")
};

const metaChannel = {
  ...baseChannel,
  provider: "meta_cloud" as const,
  providerKey: "1234567890",
  phoneNumber: "+55 47 98888-0000",
  displayName: "Meta Oficial",
  status: "connected" as const
};

function createMockPrisma(overrides: Partial<MockPrisma> = {}): MockPrisma & PrismaLike {
  return {
    channel: {
      findMany:
        overrides.channel?.findMany ??
        vi.fn().mockResolvedValue([baseChannel]),
      findFirst:
        overrides.channel?.findFirst ??
        vi.fn().mockResolvedValue(baseChannel),
      create:
        overrides.channel?.create ??
        vi.fn().mockResolvedValue(baseChannel),
      update:
        overrides.channel?.update ??
        vi.fn().mockImplementation(async (args) => {
          const status =
            typeof args.data.status === "string" ? args.data.status : baseChannel.status;

          return {
            ...baseChannel,
            status,
            updatedAt: new Date("2026-05-20T10:05:00.000Z")
          };
        }),
      delete:
        overrides.channel?.delete ??
        vi.fn().mockResolvedValue(baseChannel)
    },
    integrationConfig: {
      findUnique:
        overrides.integrationConfig?.findUnique ??
        vi.fn().mockResolvedValue(null)
    },
    contact: {
      upsert:
        overrides.contact?.upsert ??
        vi.fn().mockResolvedValue({ id: contactId })
    },
    conversation: {
      upsert:
        overrides.conversation?.upsert ??
        vi.fn().mockResolvedValue({
          id: conversationId
        }),
      update:
        overrides.conversation?.update ??
        vi.fn().mockResolvedValue({
          id: conversationId
        })
    },
    message: {
      create:
        overrides.message?.create ??
        vi.fn().mockResolvedValue({
          id: "00000000-0000-4000-8000-000000000004"
        })
    }
  } as MockPrisma & PrismaLike;
}

async function buildChannelsApp(
  prisma = createMockPrisma(),
  options: Parameters<typeof channelsRoutes>[1] = {}
) {
  const app = Fastify({ logger: false });
  const publish = vi.fn();

  app.decorate("prisma", prisma as never);
  app.decorate("realtime", { publish, addClient: vi.fn(), clientCount: vi.fn() });
  app.addHook("preHandler", async (request) => {
    request.talk = { workspaceId: "workspace_a", role: "agent" };
  });
  await app.register(channelsRoutes, options);

  return { app, prisma, publish };
}

describe("channels service", () => {
  it("creates a real Evolution channel record without touching the provider until QR starts", async () => {
    const createInstance = vi.fn().mockResolvedValue({
      instanceName: "evolution-workspace-a",
      qrCode: "1@real-qr",
      raw: {}
    });
    const setWebhook = vi.fn().mockResolvedValue({ raw: {} });
    const prisma = createMockPrisma();
    prisma.channel.create = vi.fn().mockImplementation(async (args) => ({
      ...baseChannel,
      ...args.data,
      id: channelId,
      createdAt: new Date("2026-05-20T10:00:00.000Z"),
      updatedAt: new Date("2026-05-20T10:00:00.000Z")
    }));
    const service = createChannelsService(prisma, {
      evolution: {
        mode: "real",
        webhookSecret: "webhook-secret",
        publicWebhookUrl: () =>
          "https://talk.prymeiradigital.com.br/webhooks/evolution/workspace_a",
        localWebhookUrl: () =>
          "http://localhost:3002/webhooks/evolution/workspace_a",
        client: { createInstance, connectInstance: vi.fn(), setWebhook, sendText: vi.fn(), sendMedia: vi.fn() }
      }
    });

    const result = await service.createChannel({
      workspaceId: "workspace_a",
      displayName: " WhatsApp Comercial ",
      providerKey: " requested-instance ",
      phoneNumber: " +55 47 99999-0000 "
    });

    expect(createInstance).not.toHaveBeenCalled();
    expect(setWebhook).not.toHaveBeenCalled();
    expect(prisma.channel.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace_a",
        provider: "evolution",
        providerKey: "requested-instance",
        displayName: "WhatsApp Comercial",
        phoneNumber: "+55 47 99999-0000",
        status: "disconnected"
      }
    });
    expect(result).toEqual(
      expect.objectContaining({
        provider: "evolution",
        providerKey: "requested-instance",
        displayName: "WhatsApp Comercial",
        phoneNumber: "+55 47 99999-0000",
        status: "disconnected"
      })
    );
  });

  it("generates a different provider key for each new real channel", async () => {
    const prisma = createMockPrisma();
    const createdProviderKeys: string[] = [];
    prisma.channel.create = vi.fn().mockImplementation(async (args) => {
      createdProviderKeys.push(args.data.providerKey);
      return {
        ...baseChannel,
        ...args.data,
        id: `00000000-0000-4000-8000-00000000000${createdProviderKeys.length}`,
        createdAt: new Date("2026-05-20T10:00:00.000Z"),
        updatedAt: new Date("2026-05-20T10:00:00.000Z")
      };
    });

    const service = createChannelsService(prisma, {
      evolution: {
        mode: "real",
        webhookSecret: "webhook-secret",
        publicWebhookUrl: () =>
          "https://talk.prymeiradigital.com.br/webhooks/evolution/workspace_a",
        localWebhookUrl: () =>
          "http://localhost:3002/webhooks/evolution/workspace_a",
        client: {
          createInstance: vi.fn(),
          connectInstance: vi.fn(),
          setWebhook: vi.fn(),
          sendText: vi.fn(),
          sendMedia: vi.fn()
        }
      }
    });

    await service.createChannel({ workspaceId: "workspace_a", displayName: "Comercial" });
    await service.createChannel({ workspaceId: "workspace_a", displayName: "Suporte" });

    expect(createdProviderKeys).toHaveLength(2);
    expect(createdProviderKeys[0]).not.toBe(createdProviderKeys[1]);
    expect(createdProviderKeys[0]).toMatch(/^talk-workspace-a-/);
    expect(createdProviderKeys[1]).toMatch(/^talk-workspace-a-/);
  });

  it("creates a Meta Cloud channel without starting an Evolution QR session", async () => {
    const createInstance = vi.fn();
    const connectInstance = vi.fn();
    const setWebhook = vi.fn();
    const prisma = createMockPrisma();
    prisma.channel.create = vi.fn().mockImplementation(async (args) => ({
      ...baseChannel,
      ...args.data,
      id: channelId,
      createdAt: new Date("2026-05-20T10:00:00.000Z"),
      updatedAt: new Date("2026-05-20T10:00:00.000Z")
    }));
    const service = createChannelsService(prisma, {
      evolution: {
        mode: "real",
        webhookSecret: "webhook-secret",
        publicWebhookUrl: () =>
          "https://talk.prymeiradigital.com.br/webhooks/evolution/workspace_a",
        localWebhookUrl: () =>
          "http://localhost:3002/webhooks/evolution/workspace_a",
        client: { createInstance, connectInstance, setWebhook, sendText: vi.fn(), sendMedia: vi.fn() }
      }
    });

    const result = await service.createChannel({
      workspaceId: "workspace_a",
      provider: "meta_cloud",
      displayName: " Meta Oficial ",
      providerKey: " 1234567890 ",
      phoneNumber: " +55 47 98888-0000 "
    });

    expect(createInstance).not.toHaveBeenCalled();
    expect(connectInstance).not.toHaveBeenCalled();
    expect(setWebhook).not.toHaveBeenCalled();
    expect(prisma.channel.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace_a",
        provider: "meta_cloud",
        providerKey: "1234567890",
        displayName: "Meta Oficial",
        phoneNumber: "+55 47 98888-0000",
        status: "connected"
      }
    });
    expect(result).toEqual(
      expect.objectContaining({
        provider: "meta_cloud",
        providerKey: "1234567890",
        displayName: "Meta Oficial",
        phoneNumber: "+55 47 98888-0000",
        status: "connected"
      })
    );
  });

  it("configures the Evolution webhook when creating a Meta Cloud via Evolution channel", async () => {
    const setWebhook = vi.fn().mockResolvedValue({ raw: {} });
    const prisma = createMockPrisma();
    prisma.channel.create = vi.fn().mockImplementation(async (args) => ({
      ...metaChannel,
      ...args.data,
      id: channelId,
      createdAt: new Date("2026-05-20T10:00:00.000Z"),
      updatedAt: new Date("2026-05-20T10:00:00.000Z")
    }));
    const service = createChannelsService(prisma, {
      metaEvolutionWebhook: {
        client: { setWebhook },
        publicWebhookUrl: () =>
          "https://talk.prymeiradigital.com.br/webhooks/evolution/workspace_a",
        webhookSecret: "webhook-secret"
      }
    });

    const result = await service.createChannel({
      workspaceId: "workspace_a",
      provider: "meta_cloud",
      displayName: " Meta Oficial ",
      providerKey: " official-instance ",
      phoneNumber: " +55 47 98888-0000 "
    });

    expect(setWebhook).toHaveBeenCalledWith({
      instanceName: "official-instance",
      webhookUrl: "https://talk.prymeiradigital.com.br/webhooks/evolution/workspace_a",
      webhookSecret: "webhook-secret"
    });
    expect(result).toEqual(
      expect.objectContaining({
        provider: "meta_cloud",
        providerKey: "official-instance",
        status: "connected"
      })
    );
  });

  it("keeps the Meta Cloud channel visible as failed when automatic webhook setup fails", async () => {
    const setWebhook = vi.fn().mockRejectedValue(new EvolutionClientError(500, { error: "down" }));
    const update = vi.fn().mockImplementation(async (args) => ({
      ...metaChannel,
      id: channelId,
      providerKey: "official-instance",
      status: args.data.status,
      updatedAt: new Date("2026-05-20T10:05:00.000Z")
    }));
    const prisma = createMockPrisma({
      channel: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn().mockImplementation(async (args) => ({
          ...metaChannel,
          ...args.data,
          id: channelId,
          createdAt: new Date("2026-05-20T10:00:00.000Z"),
          updatedAt: new Date("2026-05-20T10:00:00.000Z")
        })),
        update,
        delete: vi.fn()
      }
    });
    const service = createChannelsService(prisma, {
      metaEvolutionWebhook: {
        client: { setWebhook },
        publicWebhookUrl: () =>
          "https://talk.prymeiradigital.com.br/webhooks/evolution/workspace_a",
        webhookSecret: "webhook-secret"
      }
    });

    const result = await service.createChannel({
      workspaceId: "workspace_a",
      provider: "meta_cloud",
      displayName: "Meta Oficial",
      providerKey: "official-instance"
    });

    expect(setWebhook).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith({
      where: {
        workspaceId_id: {
          workspaceId: "workspace_a",
          id: channelId
        }
      },
      data: { status: "failed" }
    });
    expect(result.status).toBe("failed");
  });

  it("rejects a Meta Cloud channel without a provider key", async () => {
    const prisma = createMockPrisma();
    const service = createChannelsService(prisma);

    const error = await service
      .createChannel({
        workspaceId: "workspace_a",
        provider: "meta_cloud",
        displayName: "Meta Oficial",
        providerKey: " "
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ChannelsServiceError);
    expect(error).toMatchObject({
      code: "CHANNEL_PROVIDER_KEY_REQUIRED",
      statusCode: 400
    });
    expect(prisma.channel.create).not.toHaveBeenCalled();
  });

  it("rejects QR sessions for Meta Cloud channels before touching Evolution", async () => {
    const createInstance = vi.fn();
    const connectInstance = vi.fn();
    const setWebhook = vi.fn();
    const prisma = createMockPrisma({
      channel: {
        findMany: vi.fn(),
        findFirst: vi.fn().mockResolvedValue(metaChannel),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn()
      }
    });
    const service = createChannelsService(prisma, {
      evolution: {
        mode: "real",
        webhookSecret: "webhook-secret",
        publicWebhookUrl: () =>
          "https://talk.prymeiradigital.com.br/webhooks/evolution/workspace_a",
        localWebhookUrl: () =>
          "http://localhost:3002/webhooks/evolution/workspace_a",
        client: { createInstance, connectInstance, setWebhook, sendText: vi.fn(), sendMedia: vi.fn() }
      }
    });

    const error = await service
      .startQrSession({
        workspaceId: "workspace_a",
        channelId
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ChannelsServiceError);
    expect(error).toMatchObject({
      code: "CHANNEL_PROVIDER_UNSUPPORTED",
      statusCode: 400
    });
    expect(createInstance).not.toHaveBeenCalled();
    expect(connectInstance).not.toHaveBeenCalled();
    expect(setWebhook).not.toHaveBeenCalled();
    expect(prisma.channel.update).not.toHaveBeenCalled();
  });

  it("rejects reconnect and disconnect actions for Meta Cloud channels", async () => {
    const prisma = createMockPrisma({
      channel: {
        findMany: vi.fn(),
        findFirst: vi.fn().mockResolvedValue(metaChannel),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn()
      }
    });
    const service = createChannelsService(prisma);

    const reconnectError = await service
      .reconnectChannel({
        workspaceId: "workspace_a",
        channelId
      })
      .catch((caught: unknown) => caught);
    const disconnectError = await service
      .disconnectChannel({
        workspaceId: "workspace_a",
        channelId
      })
      .catch((caught: unknown) => caught);

    expect(reconnectError).toBeInstanceOf(ChannelsServiceError);
    expect(reconnectError).toMatchObject({
      code: "CHANNEL_PROVIDER_UNSUPPORTED",
      statusCode: 400
    });
    expect(disconnectError).toBeInstanceOf(ChannelsServiceError);
    expect(disconnectError).toMatchObject({
      code: "CHANNEL_PROVIDER_UNSUPPORTED",
      statusCode: 400
    });
    expect(prisma.integrationConfig.findUnique).not.toHaveBeenCalled();
    expect(prisma.channel.update).not.toHaveBeenCalled();
  });

  it("rejects demo inbound creation for Meta Cloud channels", async () => {
    const prisma = createMockPrisma({
      channel: {
        findMany: vi.fn(),
        findFirst: vi.fn().mockResolvedValue(metaChannel),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn()
      }
    });
    const service = createChannelsService(prisma);

    const error = await service
      .createTestInbound({
        workspaceId: "workspace_a",
        channelId
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ChannelsServiceError);
    expect(error).toMatchObject({
      code: "CHANNEL_PROVIDER_UNSUPPORTED",
      statusCode: 400
    });
    expect(prisma.contact.upsert).not.toHaveBeenCalled();
    expect(prisma.conversation.upsert).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it("starts a real QR session for an existing Evolution channel", async () => {
    const createInstance = vi.fn().mockResolvedValue({
      instanceName: baseChannel.providerKey,
      qrCode: "2@real-qr",
      raw: {}
    });
    const setWebhook = vi.fn().mockResolvedValue({ raw: {} });
    const prisma = createMockPrisma();
    const service = createChannelsService(prisma, {
      evolution: {
        mode: "real",
        webhookSecret: "webhook-secret",
        publicWebhookUrl: () =>
          "https://talk.prymeiradigital.com.br/webhooks/evolution/workspace_a",
        localWebhookUrl: () =>
          "http://localhost:3002/webhooks/evolution/workspace_a",
        client: { createInstance, connectInstance: vi.fn(), setWebhook, sendText: vi.fn(), sendMedia: vi.fn() }
      }
    });

    const result = await service.startQrSession({
      workspaceId: "workspace_a",
      channelId
    });

    expect(prisma.channel.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_a",
        id: channelId
      }
    });
    expect(createInstance).toHaveBeenCalledWith({
      instanceName: baseChannel.providerKey,
      webhookUrl: "https://talk.prymeiradigital.com.br/webhooks/evolution/workspace_a",
      webhookSecret: "webhook-secret"
    });
    expect(setWebhook).toHaveBeenCalledWith({
      instanceName: baseChannel.providerKey,
      webhookUrl: "https://talk.prymeiradigital.com.br/webhooks/evolution/workspace_a",
      webhookSecret: "webhook-secret"
    });
    expect(prisma.channel.update).toHaveBeenCalledWith({
      where: {
        workspaceId_id: {
          workspaceId: "workspace_a",
          id: channelId
        }
      },
      data: { status: "connecting" }
    });
    expect(result).toEqual(
      expect.objectContaining({
        mode: "real",
        qrCode: "2@real-qr",
        qr: expect.objectContaining({
          payload: "2@real-qr"
        }),
        channel: expect.objectContaining({
          id: channelId,
          status: "connecting"
        })
      })
    );
  });

  it("connects an existing Evolution instance when QR creation finds a reused provider key", async () => {
    const createInstance = vi.fn().mockRejectedValue(
      new EvolutionClientError(403, {
        status: 403,
        error: "Forbidden",
        response: {
          message: [`This name "${baseChannel.providerKey}" is already in use.`]
        }
      })
    );
    const connectInstance = vi.fn().mockResolvedValue({
      instanceName: baseChannel.providerKey,
      qrCode: "2@existing-real-qr",
      raw: {}
    });
    const setWebhook = vi.fn().mockResolvedValue({ raw: {} });
    const prisma = createMockPrisma();
    const service = createChannelsService(prisma, {
      evolution: {
        mode: "real",
        webhookSecret: "webhook-secret",
        publicWebhookUrl: () =>
          "https://talk.prymeiradigital.com.br/webhooks/evolution/workspace_a",
        localWebhookUrl: () =>
          "http://localhost:3002/webhooks/evolution/workspace_a",
        client: { createInstance, connectInstance, setWebhook, sendText: vi.fn(), sendMedia: vi.fn() }
      }
    });

    const result = await service.startQrSession({
      workspaceId: "workspace_a",
      channelId
    });

    expect(connectInstance).toHaveBeenCalledWith({
      instanceName: baseChannel.providerKey
    });
    expect(setWebhook).toHaveBeenCalledWith({
      instanceName: baseChannel.providerKey,
      webhookUrl: "https://talk.prymeiradigital.com.br/webhooks/evolution/workspace_a",
      webhookSecret: "webhook-secret"
    });
    expect(result).toEqual(
      expect.objectContaining({
        mode: "real",
        qrCode: "2@existing-real-qr",
        channel: expect.objectContaining({ status: "connecting" })
      })
    );
  });

  it("rejects real QR sessions when Evolution does not return a QR code", async () => {
    const createInstance = vi.fn().mockResolvedValue({
      instanceName: baseChannel.providerKey,
      qrCode: null,
      raw: {}
    });
    const prisma = createMockPrisma();
    const service = createChannelsService(prisma, {
      evolution: {
        mode: "real",
        webhookSecret: "webhook-secret",
        publicWebhookUrl: () =>
          "https://talk.prymeiradigital.com.br/webhooks/evolution/workspace_a",
        localWebhookUrl: () =>
          "http://localhost:3002/webhooks/evolution/workspace_a",
        client: { createInstance, connectInstance: vi.fn(), setWebhook: vi.fn(), sendText: vi.fn(), sendMedia: vi.fn() }
      }
    });

    const error = await service
      .startQrSession({
        workspaceId: "workspace_a",
        channelId
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ChannelsServiceError);
    expect(error).toMatchObject({
      code: "EVOLUTION_QR_UNAVAILABLE",
      statusCode: 502
    });
    expect(prisma.channel.update).not.toHaveBeenCalled();
  });

  it("explains Evolution license activation failures before starting QR", async () => {
    const createInstance = vi.fn().mockRejectedValue(
      new EvolutionClientError(503, {
        error: "service not activated",
        code: "LICENSE_REQUIRED",
        register_url: "https://wsapi.yrdnegocios.com.br/manager/login"
      })
    );
    const prisma = createMockPrisma();
    const service = createChannelsService(prisma, {
      evolution: {
        mode: "real",
        webhookSecret: "webhook-secret",
        publicWebhookUrl: () =>
          "https://talk.prymeiradigital.com.br/webhooks/evolution/workspace_a",
        localWebhookUrl: () =>
          "http://localhost:3002/webhooks/evolution/workspace_a",
        client: { createInstance, connectInstance: vi.fn(), setWebhook: vi.fn(), sendText: vi.fn(), sendMedia: vi.fn() }
      }
    });

    const error = await service
      .startQrSession({
        workspaceId: "workspace_a",
        channelId
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ChannelsServiceError);
    expect(error).toMatchObject({
      code: "EVOLUTION_LICENSE_REQUIRED",
      statusCode: 503
    });
    if (!(error instanceof Error)) {
      throw new Error("Expected an Error instance.");
    }
    expect(error.message).toContain("ativação da licenca");
    expect(prisma.channel.update).not.toHaveBeenCalled();
  });

  it("starts a simulated QR session and persists the connecting status", async () => {
    const prisma = createMockPrisma();
    const service = createChannelsService(prisma);

    const result = await service.startQrSession({
      workspaceId: "workspace_a",
      channelId
    });

    expect(prisma.integrationConfig.findUnique).toHaveBeenCalledWith({
      where: {
        workspaceId_provider: {
          workspaceId: "workspace_a",
          provider: "evolution"
        }
      }
    });
    expect(prisma.channel.update).toHaveBeenCalledWith({
      where: {
        workspaceId_id: {
          workspaceId: "workspace_a",
          id: channelId
        }
      },
      data: { status: "connecting" }
    });
    expect(result.mode).toBe("simulated");
    expect(result.qrCode).toContain("prymeira-talk-demo");
    expect(result.qr.payload).toContain("prymeira-talk-demo");
    expect(result.channel.status).toBe("connecting");
  });

  it("disconnects a channel in simulated mode when no real Evolution config exists", async () => {
    const prisma = createMockPrisma();
    const service = createChannelsService(prisma);

    const result = await service.disconnectChannel({
      workspaceId: "workspace_a",
      channelId
    });

    expect(prisma.channel.update).toHaveBeenCalledWith({
      where: {
        workspaceId_id: {
          workspaceId: "workspace_a",
          id: channelId
        }
      },
      data: { status: "disconnected" }
    });
    expect(result.mode).toBe("simulated");
    expect(result.channel.status).toBe("disconnected");
  });

  it("reconnects a simulated channel by moving it back to connecting", async () => {
    const prisma = createMockPrisma();
    const service = createChannelsService(prisma);

    const result = await service.reconnectChannel({
      workspaceId: "workspace_a",
      channelId
    });

    expect(prisma.channel.update).toHaveBeenCalledWith({
      where: {
        workspaceId_id: {
          workspaceId: "workspace_a",
          id: channelId
        }
      },
      data: { status: "connecting" }
    });
    expect(result.mode).toBe("simulated");
    expect(result.channel.status).toBe("connecting");
  });
});

describe("channels routes", () => {
  it("configures an Evolution webhook when creating a Meta Cloud channel through the route", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const prisma = createMockPrisma({
      channel: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn().mockImplementation(async (args) => ({
          ...metaChannel,
          ...args.data,
          id: channelId,
          createdAt: new Date("2026-05-20T10:00:00.000Z"),
          updatedAt: new Date("2026-05-20T10:00:00.000Z")
        })),
        update: vi.fn(),
        delete: vi.fn()
      },
      integrationConfig: {
        findUnique: vi.fn().mockResolvedValue({
          mode: "real",
          status: "configured",
          settings: {
            enabled: true,
            connectionMode: "evolution_official",
            evolutionBaseUrl: "https://wsapi.yrdnegocios.com.br",
            evolutionApiKey: "secret-key",
            evolutionInstanceName: "fallback-instance"
          }
        })
      }
    });
    const { app, publish } = await buildChannelsApp(prisma, {
      evolution: {
        mode: "simulated",
        webhookSecret: "webhook-secret",
        publicWebhookUrl: () =>
          "https://talk.prymeiradigital.com.br/webhooks/evolution/workspace_a",
        localWebhookUrl: () =>
          "http://localhost:3002/webhooks/evolution/workspace_a",
        client: null
      }
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/channels",
        payload: {
          provider: "meta_cloud",
          displayName: "Meta Oficial",
          providerKey: "official-instance",
          phoneNumber: "+55 47 98888-0000"
        }
      });

      expect(response.statusCode).toBe(201);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://wsapi.yrdnegocios.com.br/webhook/set/official-instance",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ apikey: "secret-key" })
        })
      );
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
        webhook: expect.objectContaining({
          enabled: true,
          url: "https://talk.prymeiradigital.com.br/webhooks/evolution/workspace_a",
          headers: expect.objectContaining({
            "x-prymeira-talk-secret": "webhook-secret"
          }),
          events: expect.arrayContaining(["MESSAGES_UPSERT", "MESSAGES_UPDATE", "SEND_MESSAGE"])
        })
      });
      expect(realtimeEventSchema.parse(publish.mock.calls[0]?.[0])).toEqual({
        type: "channel.updated",
        workspaceId: "workspace_a",
        payload: channelSchema.parse(response.json())
      });
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it("returns the simulated QR payload from POST /channels/:channelId/qr", async () => {
    const { app, publish } = await buildChannelsApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: `/channels/${channelId}/qr`
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          mode: "simulated",
          qrCode: expect.stringContaining("prymeira-talk-demo"),
          qr: expect.objectContaining({
            payload: expect.stringContaining("prymeira-talk-demo")
          }),
          channel: expect.objectContaining({
            id: channelId,
            status: "connecting"
          })
        })
      );
      const event = publish.mock.calls[0]?.[0];
      expect(realtimeEventSchema.parse(event)).toEqual(event);
      expect(event).toEqual({
        type: "channel.updated",
        workspaceId: "workspace_a",
        payload: channelSchema.parse(response.json().channel)
      });
    } finally {
      await app.close();
    }
  });

  it("returns HTTP 400 when QR is requested for a Meta Cloud channel", async () => {
    const prisma = createMockPrisma({
      channel: {
        findMany: vi.fn(),
        findFirst: vi.fn().mockResolvedValue(metaChannel),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn()
      }
    });
    const { app, publish } = await buildChannelsApp(prisma);

    try {
      const response = await app.inject({
        method: "POST",
        url: `/channels/${channelId}/qr`
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        code: "CHANNEL_PROVIDER_UNSUPPORTED",
        error: "This channel provider does not support Evolution QR or demo actions."
      });
      expect(prisma.channel.update).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("deletes a workspace channel and publishes a channel deleted event", async () => {
    const prisma = createMockPrisma();
    const { app, publish } = await buildChannelsApp(prisma);

    try {
      const response = await app.inject({
        method: "DELETE",
        url: `/channels/${channelId}`
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, channelId });
      expect(prisma.channel.delete).toHaveBeenCalledWith({
        where: {
          workspaceId_id: {
            workspaceId: "workspace_a",
            id: channelId
          }
        }
      });
      expect(realtimeEventSchema.parse(publish.mock.calls[0]?.[0])).toEqual({
        type: "channel.deleted",
        workspaceId: "workspace_a",
        payload: { channelId }
      });
      expect(publish).toHaveBeenCalledWith({
        type: "channel.deleted",
        workspaceId: "workspace_a",
        payload: { channelId }
      });
    } finally {
      await app.close();
    }
  });
});
