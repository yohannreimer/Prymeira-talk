import type {
  ChannelDto,
  ChannelOperationResultDto,
  ChannelQrResultDto,
  IntegrationMode
} from "@prymeira-talk/shared";

type DateLike = Date | string;

interface ChannelRecord {
  id: string;
  workspaceId: string;
  provider: "evolution";
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

export class ChannelsServiceError extends Error {
  constructor(
    public code: "CHANNEL_NOT_FOUND",
    message: string
  ) {
    super(message);
  }
}

interface ChannelTestInboundResultDto extends ChannelOperationResultDto {
  messageId: string;
}

function toIsoString(value: DateLike) {
  return value instanceof Date ? value.toISOString() : value;
}

function toChannelDto(record: ChannelRecord): ChannelDto {
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

export function createChannelsService(prisma: PrismaLike) {
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
        `demo-evolution-${Date.now().toString(36)}`;
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
