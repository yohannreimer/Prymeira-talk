import { randomUUID } from "node:crypto";
import type {
  ChannelDto,
  ChannelOperationResultDto,
  ChannelQrResultDto,
  IntegrationMode
} from "@prymeira-talk/shared";
import {
  isEvolutionInstanceNameInUseError,
  isEvolutionLicenseRequiredError
} from "../evolution/evolution.client.js";
import type { EvolutionRuntime } from "../evolution/evolution-runtime.js";

type DateLike = Date | string;

interface ChannelRecord {
  id: string;
  workspaceId: string;
  provider: ChannelDto["provider"];
  providerKey: string;
  phoneNumber: string | null;
  displayName: string | null;
  status: ChannelDto["status"];
  createdAt: DateLike;
  updatedAt: DateLike;
}

interface IntegrationConfigRecord {
  mode: IntegrationMode;
  status: string;
  settings: unknown;
}

export interface PrismaLike {
  channel: {
    findMany(args: {
      where: { workspaceId: string };
      orderBy: Array<{ createdAt: "asc" }>;
    }): Promise<ChannelRecord[]>;
    findFirst(args: {
      where: { workspaceId: string; id: string };
    }): Promise<ChannelRecord | null>;
    create(args: {
      data: {
        workspaceId: string;
        provider: "evolution";
        providerKey: string;
        displayName: string;
        phoneNumber: string | null;
        status: ChannelDto["status"];
      };
    }): Promise<ChannelRecord>;
    update(args: {
      where: { workspaceId_id: { workspaceId: string; id: string } };
      data: { status: ChannelDto["status"] };
    }): Promise<ChannelRecord>;
    delete(args: {
      where: { workspaceId_id: { workspaceId: string; id: string } };
    }): Promise<ChannelRecord>;
  };
  integrationConfig: {
    findUnique(args: {
      where: { workspaceId_provider: { workspaceId: string; provider: string } };
    }): Promise<IntegrationConfigRecord | null>;
  };
  contact: {
    upsert(args: {
      where: { workspaceId_phone: { workspaceId: string; phone: string } };
      create: { workspaceId: string; phone: string; name: string };
      update: Record<string, never>;
    }): Promise<{ id: string }>;
  };
  conversation: {
    upsert(args: {
      where: {
        workspaceId_channelId_contactId: {
          workspaceId: string;
          channelId: string;
          contactId: string;
        };
      };
      create: {
        workspaceId: string;
        channelId: string;
        contactId: string;
        status: "open";
        unreadCount: number;
      };
      update: Record<string, never>;
    }): Promise<{ id: string }>;
    update(args: {
      where: { workspaceId_id: { workspaceId: string; id: string } };
      data: {
        lastMessageAt: Date;
        lastMessagePreview: string;
        unreadCount: { increment: number };
      };
    }): Promise<{ id: string }>;
  };
  message: {
    create(args: {
      data: {
        workspaceId: string;
        conversationId: string;
        providerEventId: string;
        providerMessageId: string;
        direction: "inbound";
        type: "text";
        body: string;
        status: "delivered";
      };
    }): Promise<{ id: string }>;
  };
}

interface ChannelsServiceOptions {
  evolution?: EvolutionRuntime;
}

export class ChannelsServiceError extends Error {
  statusCode: number;

  constructor(
    public code: "CHANNEL_NOT_FOUND" | "EVOLUTION_LICENSE_REQUIRED" | "EVOLUTION_QR_UNAVAILABLE",
    message: string,
    statusCode = 404
  ) {
    super(message);
    this.name = "ChannelsServiceError";
    this.statusCode = statusCode;
  }
}

interface ChannelTestInboundResultDto extends ChannelOperationResultDto {
  messageId: string;
}

function toIsoString(value: DateLike) {
  return value instanceof Date ? value.toISOString() : value;
}

export function toChannelDto(record: ChannelRecord): ChannelDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    provider: record.provider,
    providerKey: record.providerKey,
    phoneNumber: record.phoneNumber,
    displayName: record.displayName,
    status: record.status,
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt)
  };
}

function normalizeOptional(value: string | undefined) {
  if (value === undefined) return undefined;

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function hasRealEvolutionConfig(config: IntegrationConfigRecord | null) {
  if (!config || config.mode !== "real" || config.status !== "active") {
    return false;
  }

  if (!config.settings || typeof config.settings !== "object") {
    return false;
  }

  const settings = config.settings as Record<string, unknown>;
  return typeof settings.baseUrl === "string" && typeof settings.apiKey === "string";
}

function demoQrPayload(input: { workspaceId: string; channelId: string }) {
  return `prymeira-talk-demo:${input.workspaceId}:${input.channelId}`;
}

function demoQrExpiresAt() {
  return new Date("2030-01-01T00:00:00.000Z").toISOString();
}

function realQrExpiresAt() {
  return new Date(Date.now() + 5 * 60 * 1000).toISOString();
}

function slugPart(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace"
  );
}

function createInstanceName(workspaceId: string) {
  const suffix = randomUUID().slice(0, 8);

  return `talk-${slugPart(workspaceId)}-${Date.now().toString(36)}-${suffix}`;
}

export function createChannelsService(
  prisma: PrismaLike,
  options: ChannelsServiceOptions = {}
) {
  const resolveMode = async (workspaceId: string): Promise<IntegrationMode> => {
    const config = await prisma.integrationConfig.findUnique({
      where: {
        workspaceId_provider: {
          workspaceId,
          provider: "evolution"
        }
      }
    });

    return hasRealEvolutionConfig(config) ? "real" : "simulated";
  };

  const updateChannelStatus = async (input: {
    workspaceId: string;
    channelId: string;
    status: ChannelDto["status"];
  }) => {
    return prisma.channel.update({
      where: {
        workspaceId_id: {
          workspaceId: input.workspaceId,
          id: input.channelId
        }
      },
      data: { status: input.status }
    });
  };

  return {
    async listChannels(input: { workspaceId: string }): Promise<ChannelDto[]> {
      const channels = await prisma.channel.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: [{ createdAt: "asc" }]
      });

      return channels.map(toChannelDto);
    },

    async createChannel(input: {
      workspaceId: string;
      displayName: string;
      providerKey?: string;
      phoneNumber?: string;
    }): Promise<ChannelDto> {
      const providerKey =
        normalizeOptional(input.providerKey) ??
        (options.evolution?.mode === "real" && options.evolution.client
          ? createInstanceName(input.workspaceId)
          : `demo-evolution-${Date.now().toString(36)}`);
      const channel = await prisma.channel.create({
        data: {
          workspaceId: input.workspaceId,
          provider: "evolution",
          providerKey,
          displayName: input.displayName.trim(),
          phoneNumber: normalizeOptional(input.phoneNumber) ?? null,
          status: "disconnected"
        }
      });

      return toChannelDto(channel);
    },

    async startQrSession(input: {
      workspaceId: string;
      channelId: string;
    }): Promise<ChannelQrResultDto> {
      const evolution = options.evolution;
      const client = evolution?.client;

      if (evolution?.mode === "real" && client) {
        const existingChannel = await prisma.channel.findFirst({
          where: {
            workspaceId: input.workspaceId,
            id: input.channelId
          }
        });

        if (!existingChannel) {
          throw new ChannelsServiceError("CHANNEL_NOT_FOUND", "Channel not found.");
        }

        const webhookUrl = evolution.publicWebhookUrl(input.workspaceId);
        let instance;

        try {
          instance = await client
            .createInstance({
              instanceName: existingChannel.providerKey,
              webhookUrl,
              webhookSecret: evolution.webhookSecret
            })
            .catch((error: unknown) => {
              if (!isEvolutionInstanceNameInUseError(error)) {
                throw error;
              }

              return client.connectInstance({
                instanceName: existingChannel.providerKey
              });
            });

          await client.setWebhook({
            instanceName: instance.instanceName,
            webhookUrl,
            webhookSecret: evolution.webhookSecret
          });
        } catch (error) {
          if (isEvolutionLicenseRequiredError(error)) {
            throw new ChannelsServiceError(
              "EVOLUTION_LICENSE_REQUIRED",
              "Evolution API 2.4.0+ exige ativacao da licenca antes de criar sessoes WhatsApp. Ative a instancia no Evolution Manager ou configure a licenca no container da Evolution e tente novamente.",
              503
            );
          }

          throw error;
        }

        if (!instance.qrCode) {
          throw new ChannelsServiceError(
            "EVOLUTION_QR_UNAVAILABLE",
            "Evolution did not return a QR code for this channel.",
            502
          );
        }

        const channel = await updateChannelStatus({
          ...input,
          status: "connecting"
        });

        return {
          mode: "real",
          channel: toChannelDto(channel),
          qrCode: instance.qrCode,
          qr: {
            payload: instance.qrCode,
            expiresAt: realQrExpiresAt()
          }
        };
      }

      const mode = await resolveMode(input.workspaceId);
      const channel = await updateChannelStatus({
        ...input,
        status: "connecting"
      });

      return {
        mode,
        channel: toChannelDto(channel),
        qrCode: demoQrPayload(input),
        qr: {
          payload: demoQrPayload(input),
          expiresAt: demoQrExpiresAt()
        }
      };
    },

    async reconnectChannel(input: {
      workspaceId: string;
      channelId: string;
    }): Promise<ChannelOperationResultDto> {
      const mode = await resolveMode(input.workspaceId);
      const channel = await updateChannelStatus({
        ...input,
        status: "connecting"
      });

      return {
        mode,
        channel: toChannelDto(channel)
      };
    },

    async disconnectChannel(input: {
      workspaceId: string;
      channelId: string;
    }): Promise<ChannelOperationResultDto> {
      const mode = await resolveMode(input.workspaceId);
      const channel = await updateChannelStatus({
        ...input,
        status: "disconnected"
      });

      return {
        mode,
        channel: toChannelDto(channel)
      };
    },

    async deleteChannel(input: {
      workspaceId: string;
      channelId: string;
    }): Promise<{ channelId: string }> {
      await prisma.channel.delete({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.channelId
          }
        }
      });

      return { channelId: input.channelId };
    },

    async createTestInbound(input: {
      workspaceId: string;
      channelId: string;
      phone?: string;
      body?: string;
    }): Promise<ChannelTestInboundResultDto> {
      const mode = await resolveMode(input.workspaceId);
      const channel = await prisma.channel.findFirst({
        where: {
          workspaceId: input.workspaceId,
          id: input.channelId
        }
      });

      if (!channel) {
        throw new ChannelsServiceError("CHANNEL_NOT_FOUND", "Channel not found.");
      }

      const phone = input.phone?.trim() || "5599999990000";
      const body = input.body?.trim() || "Mensagem de teste do modo demo Prymeira Talk.";
      const providerEventSeed = Date.now();
      const contact = await prisma.contact.upsert({
        where: {
          workspaceId_phone: {
            workspaceId: input.workspaceId,
            phone
          }
        },
        create: {
          workspaceId: input.workspaceId,
          phone,
          name: "Contato de teste"
        },
        update: {}
      });
      const conversation = await prisma.conversation.upsert({
        where: {
          workspaceId_channelId_contactId: {
            workspaceId: input.workspaceId,
            channelId: input.channelId,
            contactId: contact.id
          }
        },
        create: {
          workspaceId: input.workspaceId,
          channelId: input.channelId,
          contactId: contact.id,
          status: "open",
          unreadCount: 0
        },
        update: {}
      });
      const message = await prisma.message.create({
        data: {
          workspaceId: input.workspaceId,
          conversationId: conversation.id,
          providerEventId: `demo-test:${input.channelId}:${providerEventSeed}`,
          providerMessageId: `demo-test-msg:${input.channelId}:${providerEventSeed}`,
          direction: "inbound",
          type: "text",
          body,
          status: "delivered"
        }
      });

      await prisma.conversation.update({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: conversation.id
          }
        },
        data: {
          lastMessageAt: new Date(),
          lastMessagePreview: body,
          unreadCount: { increment: 1 }
        }
      });

      return {
        mode,
        channel: toChannelDto({ ...channel, updatedAt: new Date() }),
        messageId: message.id
      };
    }
  };
}
