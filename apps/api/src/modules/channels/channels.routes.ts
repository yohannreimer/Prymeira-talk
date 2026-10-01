import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { canPerform } from "../access/roles.js";
import type { EvolutionHistorySource } from "../evolution/evolution-history.js";
import type { EvolutionRuntime } from "../evolution/evolution-runtime.js";
import { resolveMetaRuntime } from "../meta/meta-runtime.js";
import { ChannelsServiceError, createChannelsService } from "./channels.service.js";
import type { PrismaLike } from "./channels.service.js";
import { createContactNameRecovery } from "./contact-name-recovery.js";

interface ChannelsRoutesOptions {
  evolution?: EvolutionRuntime;
  evolutionHistorySource?: Pick<EvolutionHistorySource, "recentContacts">;
}

const uuidParamSchema = z.string().uuid();

const channelParamsSchema = z.object({
  channelId: uuidParamSchema
});

const createChannelBodySchema = z.object({
  provider: z.enum(["evolution", "meta_cloud"]).default("evolution"),
  displayName: z.string().trim().min(1).max(160),
  providerKey: z.string().trim().min(1).max(160).optional(),
  phoneNumber: z.string().trim().min(1).max(40).optional()
});

const testInboundBodySchema = z
  .object({
    phone: z.string().trim().min(1).max(40).optional(),
    body: z.string().trim().min(1).max(1000).optional()
  })
  .optional();

// Safe by default: without an explicit dryRun: false nothing is written.
const recoverContactNamesBodySchema = z
  .object({ dryRun: z.boolean().default(true) })
  .default({ dryRun: true });

function isPrismaKnownRequestErrorCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function handleChannelsError(reply: FastifyReply, error: unknown) {
  if (error instanceof ChannelsServiceError) {
    return reply.code(error.statusCode).send({ code: error.code, error: error.message });
  }

  if (isPrismaKnownRequestErrorCode(error, "P2025")) {
    return reply.code(404).send({
      code: "CHANNEL_NOT_FOUND",
      error: "Channel not found."
    });
  }

  if (isPrismaKnownRequestErrorCode(error, "P2002")) {
    return reply.code(409).send({
      code: "CHANNEL_CONFLICT",
      error: "Channel already exists."
    });
  }

  throw error;
}

export const channelsRoutes: FastifyPluginAsync<ChannelsRoutesOptions> = async (app, options) => {
  const service = createChannelsService(app.prisma as unknown as PrismaLike, {
    evolution: options.evolution
  });

  app.get("/channels", async (request) =>
    service.listChannels({ workspaceId: request.talk.workspaceId })
  );

  app.post("/channels", async (request, reply) => {
    const body = createChannelBodySchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({ error: "Invalid channel request." });
    }

    try {
      const metaRuntime = body.data.provider === "meta_cloud"
        ? await resolveMetaRuntime(app.prisma, { workspaceId: request.talk.workspaceId })
        : null;
      const channelService = metaRuntime?.active && metaRuntime.connectionMode === "evolution_official"
        && metaRuntime.evolutionClient && options.evolution
        ? createChannelsService(app.prisma as unknown as PrismaLike, {
            evolution: options.evolution,
            metaEvolutionWebhook: {
              client: {
                setWebhook: metaRuntime.evolutionClient.setWebhook.bind(metaRuntime.evolutionClient)
              },
              publicWebhookUrl: options.evolution.publicWebhookUrl,
              webhookSecret: options.evolution.webhookSecret
            }
          })
        : service;
      const channel = await channelService.createChannel({
        workspaceId: request.talk.workspaceId,
        ...body.data
      });

      app.realtime.publish({
        type: "channel.updated",
        workspaceId: request.talk.workspaceId,
        payload: channel
      });

      return reply.code(201).send(channel);
    } catch (error) {
      return handleChannelsError(reply, error);
    }
  });

  app.post("/channels/recover-contact-names", async (request, reply) => {
    if (!canPerform(request.talk.role, "workspace.manage")) {
      return reply.code(403).send({ error: "Sem permissão para corrigir nomes de contatos." });
    }
    const body = recoverContactNamesBodySchema.safeParse(request.body ?? undefined);
    if (!body.success) {
      return reply.code(400).send({ error: "Pedido inválido." });
    }
    if (!options.evolutionHistorySource) {
      return reply.code(409).send({ code: "EVOLUTION_HISTORY_UNAVAILABLE", error: "Histórico da Evolution indisponível" });
    }
    const channels = await app.prisma.channel.findMany({
      where: { workspaceId: request.talk.workspaceId, provider: "evolution", status: "connected" },
      select: { id: true, providerKey: true }
    });
    if (!channels.length) {
      return reply.code(409).send({
        code: "NO_CONNECTED_EVOLUTION_CHANNEL",
        error: "Nenhum canal da Evolution conectado. Conecte um canal para buscar os nomes dos contatos."
      });
    }
    return createContactNameRecovery({ prisma: app.prisma, source: options.evolutionHistorySource }).recover({
      workspaceId: request.talk.workspaceId,
      channels,
      dryRun: body.data.dryRun
    });
  });

  app.post("/channels/:channelId/qr", async (request, reply) => {
    const params = channelParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid channel request." });
    }

    try {
      const result = await service.startQrSession({
        workspaceId: request.talk.workspaceId,
        channelId: params.data.channelId
      });

      app.realtime.publish({
        type: "channel.updated",
        workspaceId: request.talk.workspaceId,
        payload: result.channel
      });

      return result;
    } catch (error) {
      return handleChannelsError(reply, error);
    }
  });

  app.post("/channels/:channelId/reconnect", async (request, reply) => {
    const params = channelParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid channel request." });
    }

    try {
      const result = await service.reconnectChannel({
        workspaceId: request.talk.workspaceId,
        channelId: params.data.channelId
      });

      app.realtime.publish({
        type: "channel.updated",
        workspaceId: request.talk.workspaceId,
        payload: result.channel
      });

      return result;
    } catch (error) {
      return handleChannelsError(reply, error);
    }
  });

  app.post("/channels/:channelId/disconnect", async (request, reply) => {
    const params = channelParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid channel request." });
    }

    try {
      const result = await service.disconnectChannel({
        workspaceId: request.talk.workspaceId,
        channelId: params.data.channelId
      });

      app.realtime.publish({
        type: "channel.updated",
        workspaceId: request.talk.workspaceId,
        payload: result.channel
      });

      return result;
    } catch (error) {
      return handleChannelsError(reply, error);
    }
  });

  app.delete("/channels/:channelId", async (request, reply) => {
    const params = channelParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid channel request." });
    }

    try {
      const result = await service.deleteChannel({
        workspaceId: request.talk.workspaceId,
        channelId: params.data.channelId
      });

      app.realtime.publish({
        type: "channel.deleted",
        workspaceId: request.talk.workspaceId,
        payload: { channelId: result.channelId }
      });

      return { ok: true, channelId: result.channelId };
    } catch (error) {
      return handleChannelsError(reply, error);
    }
  });

  app.post("/channels/:channelId/test-inbound", async (request, reply) => {
    const params = channelParamsSchema.safeParse(request.params);
    const body = testInboundBodySchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid channel test request." });
    }

    try {
      const result = await service.createTestInbound({
        workspaceId: request.talk.workspaceId,
        channelId: params.data.channelId,
        ...body.data
      });

      app.realtime.publish({
        type: "channel.updated",
        workspaceId: request.talk.workspaceId,
        payload: result.channel
      });

      return result;
    } catch (error) {
      return handleChannelsError(reply, error);
    }
  });
};
