import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import type { EvolutionRuntime } from "../evolution/evolution-runtime.js";
import { ChannelsServiceError, createChannelsService } from "./channels.service.js";
import type { PrismaLike } from "./channels.service.js";

interface ChannelsRoutesOptions {
  evolution?: EvolutionRuntime;
}

const uuidParamSchema = z.string().uuid();

const channelParamsSchema = z.object({
  channelId: uuidParamSchema
});

const createChannelBodySchema = z.object({
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
  if (error instanceof ChannelsServiceError) {
    return reply.code(404).send({ code: error.code, error: error.message });
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
      const channel = await service.createChannel({
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
