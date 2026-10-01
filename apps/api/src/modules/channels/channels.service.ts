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
import type { WahaRuntime } from '../waha/waha.client.js';
import { createChannelConnectionsService, type ConnectionPrisma, type ConnectionLifecycle } from './channel-connections.js';
import type { Channel } from '@prisma/client';
import { toChannelDto } from './channel-dto.js';
export { toChannelDto } from './channel-dto.js';

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
  redundancyEnabled?: boolean;
  activeConnectionId?: string | null;
}

interface IntegrationConfigRecord {
  mode: IntegrationMode;
  status: string;
  settings: unknown;
}

export interface PrismaLike {
  channelConnection?: ConnectionPrisma['channelConnection'];
  $transaction?: ConnectionPrisma['$transaction'];
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
        provider: ChannelDto["provider"];
        providerKey: string;
        displayName: string;
        phoneNumber: string | null;
        status: ChannelDto["status"];
        activeConnectionId?: string;
        connections?: { create: { id: string; provider: 'evolution'; sessionName: string; status: ChannelDto['status']; eligible: boolean } };
        historyImportStatus?: string | null;
        historyImportNextAt?: Date | null;
      };
    }): Promise<ChannelRecord>;
    update(args: {
      where: { workspaceId_id: { workspaceId: string; id: string } };
      data: {
        status: ChannelDto["status"];
        historyImportStatus?: string;
        historyImportNextAt?: Date;
        historyImportAttempts?: number;
        historyImportCompletedAt?: null;
        historyImportLeaseToken?: null;
        historyImportLeaseUntil?: null;
      };
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
  waha?: WahaRuntime;
  metaEvolutionWebhook?: {
    client: {
      setWebhook(input: {
        instanceName: string;
        webhookUrl: string;
        webhookSecret: string;
      }): Promise<{ raw: unknown }>;
    };
    publicWebhookUrl(workspaceId: string): string;
    webhookSecret: string;
  };
}

export class ChannelsServiceError extends Error {
  statusCode: number;

  constructor(
    public code:
      | "CHANNEL_NOT_FOUND"
      | "CHANNEL_PROVIDER_KEY_REQUIRED"
      | "CHANNEL_PROVIDER_UNSUPPORTED"
      | "EVOLUTION_LICENSE_REQUIRED"
      | "EVOLUTION_ALREADY_LINKED"
      | "EVOLUTION_DISCONNECT_UNAVAILABLE"
      | "EVOLUTION_QR_UNAVAILABLE",
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
  const physical = prisma?.channelConnection && prisma.$transaction
    ? createChannelConnectionsService(prisma as unknown as ConnectionPrisma, options)
    : null;
  const describe = (record: ChannelRecord) => physical ? physical.describe(record as Channel) : Promise.resolve(toChannelDto(record));
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

  const completePrimaryLifecycle = async (
    input: { workspaceId: string; channelId: string },
    operation: ConnectionLifecycle | null,
    data: Parameters<PrismaLike['channel']['update']>[0]['data']
  ): Promise<ChannelRecord> => {
    if (physical && operation) return physical.completePrimaryLifecycle(operation, data);
    return prisma.channel.update({ where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.channelId } }, data });
  };

  const getEvolutionChannel = async (input: {
    workspaceId: string;
    channelId: string;
  }) => {
    const channel = await prisma.channel.findFirst({
      where: {
        workspaceId: input.workspaceId,
        id: input.channelId
      }
    });

    if (!channel) {
      throw new ChannelsServiceError("CHANNEL_NOT_FOUND", "Channel not found.");
    }

    if (channel.provider !== "evolution") {
      throw new ChannelsServiceError(
        "CHANNEL_PROVIDER_UNSUPPORTED",
        "This channel provider does not support Evolution QR or demo actions.",
        400
      );
    }

    return channel;
  };

  return {
    async listChannels(input: { workspaceId: string }): Promise<ChannelDto[]> {
      const channels = await prisma.channel.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: [{ createdAt: "asc" }]
      });

      return Promise.all(channels.map(describe));
    },

    async createChannel(input: {
      workspaceId: string;
      displayName: string;
      provider?: ChannelDto["provider"];
      providerKey?: string;
      phoneNumber?: string;
    }): Promise<ChannelDto> {
      const provider = input.provider ?? "evolution";
      const requestedProviderKey = normalizeOptional(input.providerKey);

      if (provider === "meta_cloud") {
        if (!requestedProviderKey) {
          throw new ChannelsServiceError(
            "CHANNEL_PROVIDER_KEY_REQUIRED",
            "Meta Cloud channels require a provider key.",
            400
          );
        }

        const channel = await prisma.channel.create({
          data: {
            workspaceId: input.workspaceId,
            provider,
            providerKey: requestedProviderKey,
            displayName: input.displayName.trim(),
            phoneNumber: normalizeOptional(input.phoneNumber) ?? null,
            status: "connected"
          }
        });

        if (options.metaEvolutionWebhook) {
          try {
            await options.metaEvolutionWebhook.client.setWebhook({
              instanceName: requestedProviderKey,
              webhookUrl: options.metaEvolutionWebhook.publicWebhookUrl(input.workspaceId),
              webhookSecret: options.metaEvolutionWebhook.webhookSecret
            });
          } catch {
            const failedChannel = await prisma.channel.update({
              where: {
                workspaceId_id: {
                  workspaceId: input.workspaceId,
                  id: channel.id
                }
              },
              data: { status: "failed" }
            });

            return toChannelDto(failedChannel);
          }
        }

        return toChannelDto(channel);
      }

      const providerKey =
        requestedProviderKey ??
        (options.evolution?.mode === "real" && options.evolution.client
          ? createInstanceName(input.workspaceId)
          : `demo-evolution-${Date.now().toString(36)}`);
      const primaryId = randomUUID();
      const channel = await prisma.channel.create({
        data: {
          workspaceId: input.workspaceId,
          provider: "evolution",
          providerKey,
          displayName: input.displayName.trim(),
          phoneNumber: normalizeOptional(input.phoneNumber) ?? null,
          status: "disconnected",
          ...(physical ? { activeConnectionId: primaryId, connections: { create: { id: primaryId, provider: 'evolution' as const, sessionName: providerKey, status: 'disconnected' as const, eligible: false } } } : {}),
          ...(options.evolution?.mode === "real" ? {
            historyImportStatus: "pending",
            historyImportNextAt: new Date(Date.now() + 30_000)
          } : {})
        }
      });

      return describe(channel);
    },

    async startQrSession(input: {
      workspaceId: string;
      channelId: string;
    }): Promise<ChannelQrResultDto> {
      const existingChannel = await getEvolutionChannel(input);
      const operation = physical ? await physical.beginPrimaryLifecycle(existingChannel as Channel) : null;
      try {
        const evolution = options.evolution;
        const client = evolution?.client;

        if (evolution?.mode === "real" && client) {
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
                "Evolution API 2.4.0+ exige ativação da licenca antes de criar sessoes WhatsApp. Ative a instancia no Evolution Manager ou configure a licenca no container da Evolution e tente novamente.",
                503
              );
            }

            throw error;
          }

          if (!instance.qrCode) {
            const connectionState = client.getConnectionState
              ? await client.getConnectionState({ instanceName: existingChannel.providerKey }).catch(() => null)
              : null;

            if (connectionState === "open") {
              throw new ChannelsServiceError(
                "EVOLUTION_ALREADY_LINKED",
                "A Evolution informa que esta sessão já está vinculada e não gerou QR. Se as mensagens não funcionam, clique em Desconectar e depois em Reconectar para vincular o WhatsApp novamente.",
                409
              );
            }

            throw new ChannelsServiceError(
              "EVOLUTION_QR_UNAVAILABLE",
              "Evolution did not return a QR code for this channel.",
              502
            );
          }

          const channel = await completePrimaryLifecycle(input, operation, {
            status: "connecting",
            historyImportStatus: "pending",
            historyImportNextAt: new Date(Date.now() + 30_000),
            historyImportAttempts: 0,
            historyImportCompletedAt: null,
            historyImportLeaseToken: null,
            historyImportLeaseUntil: null
          });

          const connectionId = physical ? (await physical.ensurePrimary(channel as Channel)).id : undefined;

          return {
            mode: "real",
            channel: await describe(channel),
            connectionId,
            provider: 'evolution',
            qrCode: instance.qrCode,
            qr: {
              payload: instance.qrCode,
              expiresAt: realQrExpiresAt(),
              issuedAt: new Date().toISOString()
            }
          };
        }

        const mode = await resolveMode(input.workspaceId);
        const channel = await completePrimaryLifecycle(input, operation, { status: "connecting" });
        const connectionId = physical ? (await physical.ensurePrimary(channel as Channel)).id : undefined;

        return {
          mode,
          channel: await describe(channel),
          connectionId,
          provider: 'evolution',
          qrCode: demoQrPayload(input),
          qr: {
            payload: demoQrPayload(input),
            expiresAt: demoQrExpiresAt()
          }
        };
      } finally { if (physical && operation) await physical.finishPrimaryLifecycle(operation); }
    },

    async reconnectChannel(input: {
      workspaceId: string;
      channelId: string;
    }): Promise<ChannelOperationResultDto> {
      const existingChannel = await getEvolutionChannel(input);
      const operation = physical ? await physical.beginPrimaryLifecycle(existingChannel as Channel) : null;
      try {
        const mode = await resolveMode(input.workspaceId);
        const channel = await completePrimaryLifecycle(input, operation, { status: "connecting" });

        return {
          mode,
          channel: await describe(channel)
        };
      } finally { if (physical && operation) await physical.finishPrimaryLifecycle(operation); }
    },

    async disconnectChannel(input: {
      workspaceId: string;
      channelId: string;
    }): Promise<ChannelOperationResultDto> {
      const existingChannel = await getEvolutionChannel(input);
      const operation = physical ? await physical.beginPrimaryLifecycle(existingChannel as Channel) : null;
      try {
        const mode = await resolveMode(input.workspaceId);
        if (options.evolution?.mode === "real") {
          if (!options.evolution?.client?.logoutInstance) {
            throw new ChannelsServiceError(
              "EVOLUTION_DISCONNECT_UNAVAILABLE",
              "Não foi possível encerrar a sessão na Evolution no momento.",
              503
            );
          }
          await options.evolution.client.logoutInstance({ instanceName: existingChannel.providerKey });
        }
        const channel = await completePrimaryLifecycle(input, operation, { status: "disconnected" });

        return {
          mode,
          channel: await describe(channel)
        };
      } finally { if (physical && operation) await physical.finishPrimaryLifecycle(operation); }
    },

    async deleteChannel(input: {
      workspaceId: string;
      channelId: string;
    }): Promise<{ channelId: string }> {
      if (physical) {
        const channel = await prisma.channel.findFirst({ where: { workspaceId: input.workspaceId, id: input.channelId } });
        if (!channel) throw new ChannelsServiceError('CHANNEL_NOT_FOUND', 'Channel not found.');
        if (channel.provider === 'evolution') await physical.deleteSecondary(channel as Channel);
      }
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

      if (channel.provider !== "evolution") {
        throw new ChannelsServiceError(
          "CHANNEL_PROVIDER_UNSUPPORTED",
          "This channel provider does not support Evolution QR or demo actions.",
          400
        );
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
