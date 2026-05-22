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
        })
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

async function buildChannelsApp(prisma = createMockPrisma()) {
  const app = Fastify({ logger: false });
  const publish = vi.fn();

  app.decorate("prisma", prisma as never);
  app.decorate("realtime", { publish, addClient: vi.fn(), clientCount: vi.fn() });
  app.addHook("preHandler", async (request) => {
    request.talk = { workspaceId: "workspace_a", role: "agent" };
  });
  await app.register(channelsRoutes);

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
        client: { createInstance, connectInstance: vi.fn(), setWebhook, sendText: vi.fn() }
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
        client: { createInstance, connectInstance: vi.fn(), setWebhook, sendText: vi.fn() }
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
        client: { createInstance, connectInstance, setWebhook, sendText: vi.fn() }
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
        client: { createInstance, connectInstance: vi.fn(), setWebhook: vi.fn(), sendText: vi.fn() }
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
});
