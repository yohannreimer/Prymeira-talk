import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import type { ChannelHealthDto, ChannelWatchdogStatusDto } from "@prymeira-talk/shared";
import type { EvolutionRuntime } from "../evolution/evolution-runtime.js";
import { resolveMetaRuntime } from "../meta/meta-runtime.js";
import { ChannelsServiceError, createChannelsService } from "./channels.service.js";
import type { PrismaLike } from "./channels.service.js";
import { ConnectionServiceError, createChannelConnectionsService } from './channel-connections.js';
import type { WahaRuntime } from '../waha/waha.client.js';

interface ChannelsRoutesOptions {
  evolution?: EvolutionRuntime;
  waha?: WahaRuntime;
  channelHealth?: {
    getHealth(workspaceId: string): ChannelHealthDto[];
    status(): Omit<ChannelWatchdogStatusDto, "enabled">;
    markManualDisconnect(channelId: string): void;
    clearManualDisconnect(channelId: string): void;
  };
}

const uuidParamSchema = z.string().uuid();

const channelParamsSchema = z.object({
  channelId: uuidParamSchema
});

const channelListQuerySchema = z.object({ includeArchived: z.enum(["true", "false"]).optional() });

const deleteChannelBodySchema = z.object({ confirmationName: z.string().max(200).optional() }).optional();

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

function isPrismaKnownRequestErrorCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function handleChannelsError(reply: FastifyReply, error: unknown) {
  if (error instanceof ChannelsServiceError || error instanceof ConnectionServiceError) {
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
    evolution: options.evolution,
    waha: options.waha
  });
  const physical = createChannelConnectionsService(app.prisma, options);
  const physicalParams = channelParamsSchema.extend({ connectionId: uuidParamSchema });
  app.patch('/channels/:channelId/redundancy', async (request, reply) => {
    const params = channelParamsSchema.safeParse(request.params);
    const body = z.object({ enabled: z.boolean() }).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'Invalid redundancy request.' });
    try {
      const result = await physical.setRedundancy({ workspaceId: request.talk.workspaceId, channelId: params.data.channelId, enabled: body.data.enabled });
      app.realtime.publish({ type: 'channel.updated', workspaceId: request.talk.workspaceId, payload: result.channel });
      return result;
    } catch (error) { return handleChannelsError(reply, error); }
  });
  app.get('/channels/:channelId/connections/:connectionId/state', async (request, reply) => {
    const params = physicalParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid connection request.' });
    try {
      const result = await physical.refresh({ workspaceId: request.talk.workspaceId, ...params.data });
      app.realtime.publish({ type: 'channel.updated', workspaceId: request.talk.workspaceId, payload: result.channel });
      return result;
    } catch (error) { return handleChannelsError(reply, error); }
  });
  for (const action of ['qr', 'reconnect', 'disconnect'] as const) {
    app.post(`/channels/:channelId/connections/:connectionId/${action}`, async (request, reply) => {
      const params = physicalParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'Invalid connection request.' });
      const scope = { workspaceId: request.talk.workspaceId, ...params.data };
      try {
        const { connection } = await physical.getConnection(scope);
        const result = connection.provider === 'evolution'
          ? action === 'disconnect' ? await service.disconnectChannel(scope) : await service.startQrSession(scope)
          : action === 'disconnect' ? await physical.disconnect(scope) : await physical.startQr(scope);
        app.realtime.publish({ type: 'channel.updated', workspaceId: request.talk.workspaceId, payload: result.channel });
        return result;
      } catch (error) { return handleChannelsError(reply, error); }
    });
  }

  app.get("/channels", async (request) => {
    const query = channelListQuerySchema.safeParse(request.query);
    return service.listChannels({
      workspaceId: request.talk.workspaceId,
      includeArchived: query.success && query.data.includeArchived === "true"
    });
  });

  app.get("/channels/health", async (request) => ({
    health: options.channelHealth?.getHealth(request.talk.workspaceId) ?? [],
    watchdog: options.channelHealth
      ? { enabled: true, ...options.channelHealth.status() }
      : { enabled: false, lastTickAt: null, lastTickOk: true, lastError: null, unreachable: false }
  }));

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

      options.channelHealth?.clearManualDisconnect(params.data.channelId);

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

      options.channelHealth?.clearManualDisconnect(params.data.channelId);

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

      options.channelHealth?.markManualDisconnect(params.data.channelId);

      return result;
    } catch (error) {
      return handleChannelsError(reply, error);
    }
  });

  for (const action of ["archive", "unarchive"] as const) {
    app.post(`/channels/:channelId/${action}`, async (request, reply) => {
      const params = channelParamsSchema.safeParse(request.params);

      if (!params.success) {
        return reply.code(400).send({ error: "Invalid channel request." });
      }

      try {
        const input = { workspaceId: request.talk.workspaceId, channelId: params.data.channelId };
        const result = action === "archive" ? await service.archiveChannel(input) : await service.unarchiveChannel(input);
        // Archiving is a deliberate stop: the watchdog must not try to reconnect the channel.
        if (action === "archive") options.channelHealth?.markManualDisconnect(params.data.channelId);
        app.realtime.publish({ type: "channel.updated", workspaceId: request.talk.workspaceId, payload: result.channel });
        return result;
      } catch (error) {
        return handleChannelsError(reply, error);
      }
    });
  }

  app.get("/channels/:channelId/deletion-impact", async (request, reply) => {
    const params = channelParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid channel request." });
    }

    try {
      return await service.getDeletionImpact({ workspaceId: request.talk.workspaceId, channelId: params.data.channelId });
    } catch (error) {
      return handleChannelsError(reply, error);
    }
  });

  app.delete("/channels/:channelId", async (request, reply) => {
    const params = channelParamsSchema.safeParse(request.params);
    const body = deleteChannelBodySchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid channel request." });
    }

    try {
      const result = await service.deleteChannel({
        workspaceId: request.talk.workspaceId,
        channelId: params.data.channelId,
        confirmationName: body.data?.confirmationName
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
