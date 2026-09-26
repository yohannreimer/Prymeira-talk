import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { canPerform } from "../access/roles.js";
import { CampaignsServiceError, createCampaignsService } from "./campaigns.service.js";
import type { PrismaLike } from "./campaigns.service.js";
import type { EvolutionRuntime } from "../evolution/evolution-runtime.js";
import { resolveMetaRuntime } from "../meta/meta-runtime.js";
import { previewCampaignAudience } from "./campaign-audience-preview.js";
import { CampaignActivationError, createCampaignActivationService } from "./campaign-activation.service.js";
import { CampaignControlError, createCampaignControlsService } from "./campaign-controls.service.js";
import { nextCampaignInstant, DEFAULT_CAMPAIGN_CADENCE } from "./campaign-cadence.js";
import { createInboxQuickSendService, InboxQuickSendError } from "./inbox-quick-send.service.js";

const uuidParamSchema = z.string().uuid();

const campaignParamsSchema = z.object({
  campaignId: uuidParamSchema
});
const campaignRecipientParamsSchema = campaignParamsSchema.extend({ recipientId: uuidParamSchema });

const audienceSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("board"),
      boardId: uuidParamSchema,
      stageId: uuidParamSchema.optional()
    }),
    z.object({
      type: z.literal("imported"),
      rows: z.array(
        z.object({
          name: z.string().optional(),
          phone: z.string().trim().min(3).max(40),
          fields: z.record(z.string(), z.string()).optional()
        })
      ).min(1).max(5000)
    })
  ]);

const cadenceSchema = z.object({
  minDelaySeconds: z.number().min(0).max(86_400),
  maxDelaySeconds: z.number().min(0).max(86_400),
  batchSize: z.number().int().min(0).max(10_000),
  pauseMinSeconds: z.number().min(0).max(86_400),
  pauseMaxSeconds: z.number().min(0).max(86_400),
  windowStart: z.string().optional(),
  windowEnd: z.string().optional()
});

const createCampaignBodySchema = z.object({
  name: z.string().trim().min(1).max(160),
  audience: audienceSchema,
  messageBody: z.string().trim().min(1).max(2000),
  templates: z.array(z.string().trim().min(1).max(2000)).min(1).max(6).optional(),
  fallbackName: z.string().trim().min(1).max(80).optional(),
  cadence: cadenceSchema.optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
  timeZone: z.string().min(1).max(100).optional()
});

const updateCampaignBodySchema = createCampaignBodySchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, "At least one campaign field is required.");

const metaTemplateComponentTypeSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z.enum(["header", "body"])
);

const metaTemplateTextParameterSchema = z
  .object({
    type: z.literal("text"),
    text: z.string()
  })
  .strict();

const metaTemplateSendComponentSchema = z
  .object({
    type: metaTemplateComponentTypeSchema,
    parameters: z.array(metaTemplateTextParameterSchema).optional()
  })
  .strict();

const sendMetaTemplateBodySchema = z.object({
  channelId: uuidParamSchema.optional(),
  channelIds: z.array(uuidParamSchema).min(1).max(20).optional(),
  template: z.object({
    name: z.string().trim().min(1).max(512),
    language: z.string().trim().min(1).max(64),
    components: z.array(metaTemplateSendComponentSchema).optional()
  })
});

const sendRealBodySchema = z
  .object({
    channelIds: z.array(uuidParamSchema).min(1).max(20).optional()
  })
  .optional();

const inboxQuickSendBodySchema = z.object({
  confirmation: z.literal(true),
  idempotencyKey: uuidParamSchema,
  channelId: uuidParamSchema,
  body: z.string().trim().min(1).max(2000),
  recipients: z.array(z.object({
    contactId: uuidParamSchema.optional(), phone: z.string().trim().min(3).max(40).optional(),
    name: z.string().trim().max(200).optional()
  }).refine((recipient) => recipient.contactId || recipient.phone)).min(1).max(5000)
});

function isPrismaKnownRequestErrorCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function handleCampaignsError(reply: FastifyReply, error: unknown) {
  if (error instanceof CampaignsServiceError) {
    const statusCode =
      error.code === "CAMPAIGN_AUDIENCE_INVALID"
        ? 400
        : error.code === "CAMPAIGN_BOARD_NOT_FOUND"
          ? 404
          : error.code === "CAMPAIGN_CHANNEL_NOT_FOUND"
            ? 404
            : error.code === "CAMPAIGN_EVOLUTION_NOT_CONFIGURED"
              ? 409
              : error.code === "CAMPAIGN_META_NOT_CONFIGURED"
                ? 409
                : error.code === "CAMPAIGN_TEMPLATE_NOT_FOUND"
                  ? 404
              : error.code === "CAMPAIGN_TEMPLATE_COMPONENT_INVALID"
                    ? 400
                    : error.code === "CAMPAIGN_NOT_DRAFT"
                      ? 409
              : 404;

    return reply.code(statusCode).send({ code: error.code, error: error.message });
  }

  if (isPrismaKnownRequestErrorCode(error, "P2025")) {
    return reply.code(404).send({
      code: "CAMPAIGN_NOT_FOUND",
      error: "Campaign not found."
    });
  }

  throw error;
}

function requireCampaignManage(
  role: Parameters<typeof canPerform>[0],
  reply: FastifyReply
) {
  if (canPerform(role, "campaign.manage")) {
    return true;
  }

  reply.code(403).send({
    code: "CAMPAIGN_MANAGE_FORBIDDEN",
    error: "Campaign management permission required."
  });
  return false;
}

export interface CampaignsRoutesOptions {
  evolution?: EvolutionRuntime;
}

export const campaignsRoutes: FastifyPluginAsync<CampaignsRoutesOptions> = async (app, options) => {
  const service = createCampaignsService(app.prisma as unknown as PrismaLike, {
    evolution: options.evolution
  });
  const activation = createCampaignActivationService(app.prisma);
  const controls = createCampaignControlsService(app.prisma);
  const inboxQuickSend = createInboxQuickSendService(app.prisma);

  app.post('/inbox/quick-sends', async (request, reply) => {
    if (!canPerform(request.talk.role, 'conversation.reply')) return reply.code(403).send({ error: 'Sem permissão para enviar mensagens.' });
    if (options.evolution?.mode !== 'real' || !options.evolution.client?.checkWhatsappNumbersAvailability) {
      return reply.code(409).send({ error: 'O envio WhatsApp não está disponível agora.' });
    }
    const body = inboxQuickSendBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Revise os destinatários e a mensagem.' });
    try {
      return reply.code(201).send(await inboxQuickSend.enqueue({
        ...body.data, workspaceId: request.talk.workspaceId,
        actorId: request.talk.clerkUserId ?? request.talk.workspaceId
      }));
    } catch (error) {
      if (error instanceof InboxQuickSendError) return reply.code(error.code === 'CONTACT_NOT_FOUND' ? 404 : 409)
        .send({ code: error.code, error: error.message });
      throw error;
    }
  });

  app.get('/inbox/quick-sends/latest', async (request) => {
    const campaign = await app.prisma.campaign.findFirst({ where: {
      workspaceId: request.talk.workspaceId, startMode: 'inbox_quick',
      confirmedBy: request.talk.clerkUserId ?? request.talk.workspaceId,
      status: { in: ['scheduled', 'sending', 'paused', 'needs_attention'] }
    }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    return { campaignId: campaign?.id ?? null };
  });

  app.get('/inbox/quick-sends/:campaignId', async (request, reply) => {
    const params = campaignParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Envio inválido.' });
    const campaign = await app.prisma.campaign.findFirst({ where: {
      workspaceId: request.talk.workspaceId, id: params.data.campaignId, startMode: 'inbox_quick'
    }, select: { confirmedBy: true } });
    if (!campaign) return reply.code(404).send({ error: 'Envio não encontrado.' });
    if (!canPerform(request.talk.role, 'campaign.manage') && campaign.confirmedBy !== request.talk.clerkUserId) {
      return reply.code(403).send({ error: 'Sem permissão para acompanhar este envio.' });
    }
    return controls.progress(request.talk.workspaceId, params.data.campaignId);
  });

  app.post('/inbox/quick-sends/:campaignId/cancel', async (request, reply) => {
    const params = campaignParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Envio inválido.' });
    const campaign = await app.prisma.campaign.findFirst({ where: {
      workspaceId: request.talk.workspaceId, id: params.data.campaignId, startMode: 'inbox_quick'
    }, select: { confirmedBy: true } });
    if (!campaign) return reply.code(404).send({ error: 'Envio não encontrado.' });
    if (!canPerform(request.talk.role, 'campaign.manage') && campaign.confirmedBy !== request.talk.clerkUserId) {
      return reply.code(403).send({ error: 'Sem permissão para cancelar este envio.' });
    }
    try { return await controls.cancelRemaining(request.talk.workspaceId, params.data.campaignId); }
    catch (error) {
      if (error instanceof CampaignControlError) return reply.code(409).send({ code: error.code, error: error.message });
      throw error;
    }
  });

  app.post('/inbox/quick-sends/:campaignId/resume', async (request, reply) => {
    const params = campaignParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Envio inválido.' });
    const campaign = await app.prisma.campaign.findFirst({ where: {
      workspaceId: request.talk.workspaceId, id: params.data.campaignId, startMode: 'inbox_quick'
    }, select: { confirmedBy: true } });
    if (!campaign) return reply.code(404).send({ error: 'Envio não encontrado.' });
    if (!canPerform(request.talk.role, 'campaign.manage') && campaign.confirmedBy !== request.talk.clerkUserId) {
      return reply.code(403).send({ error: 'Sem permissão para retomar este envio.' });
    }
    try { return await controls.resume(request.talk.workspaceId, params.data.campaignId); }
    catch (error) {
      if (error instanceof CampaignControlError) return reply.code(409).send({ code: error.code, error: error.message });
      throw error;
    }
  });

  async function verifiedPreview(workspaceId: string, campaignId: string, channelId: string,
    schedule?: { startMode: "now" | "scheduled"; scheduledAt?: string | null; timeZone: string }) {
    if (options.evolution?.mode !== "real" || !options.evolution.client?.checkWhatsappNumbersAvailability) {
      throw new CampaignsServiceError("CAMPAIGN_EVOLUTION_NOT_CONFIGURED",
        "A verificação de WhatsApp não está disponível agora.");
    }
    const channel = await app.prisma.channel.findFirst({
      where: { id: channelId, workspaceId, provider: "evolution", status: "connected" },
      select: { providerKey: true }
    });
    if (!channel) throw new CampaignsServiceError("CAMPAIGN_CHANNEL_NOT_FOUND",
      "Canal Evolution conectado não encontrado.");
    const campaign = await service.getCampaign({ workspaceId, campaignId });
    const contacts = await service.resolveAudience({ workspaceId, campaignId });
    const preview = await previewCampaignAudience({ campaign, channelId, contacts,
      verify: async (numbers) => (await options.evolution!.client!.checkWhatsappNumbersAvailability!({
        instanceName: channel.providerKey, numbers
      })).numbers });
    if (!schedule) return preview;
    const start = schedule.startMode === "scheduled" ? new Date(schedule.scheduledAt ?? "") : new Date();
    if (!Number.isFinite(start.getTime())) throw new CampaignsServiceError("CAMPAIGN_AUDIENCE_INVALID",
      "Escolha uma data e hora válidas.");
    let effectiveStartAt: string;
    try {
      effectiveStartAt = nextCampaignInstant(start, 0, schedule.timeZone,
        { ...DEFAULT_CAMPAIGN_CADENCE, ...campaign.cadence }).toISOString();
    } catch {
      throw new CampaignsServiceError("CAMPAIGN_AUDIENCE_INVALID",
        "O fuso ou a janela de envio não é válido.");
    }
    return { ...preview, effectiveStartAt };
  }

  app.get("/campaigns", async (request) =>
    service.listCampaigns({ workspaceId: request.talk.workspaceId })
  );

  app.delete("/campaigns/:campaignId", async (request, reply) => {
    if (!requireCampaignManage(request.talk.role, reply)) return reply;
    const params = campaignParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid campaign request." });

    try {
      await service.deleteDraft({
        workspaceId: request.talk.workspaceId,
        campaignId: params.data.campaignId
      });
      return reply.code(204).send();
    } catch (error) {
      return handleCampaignsError(reply, error);
    }
  });

  app.post("/campaigns", async (request, reply) => {
    if (!requireCampaignManage(request.talk.role, reply)) {
      return reply;
    }

    const body = createCampaignBodySchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({ error: "Invalid campaign request." });
    }

    try {
      const campaign = await service.createCampaign({
        workspaceId: request.talk.workspaceId,
        ...body.data
      });

      app.realtime.publish({
        type: "campaign.updated",
        workspaceId: request.talk.workspaceId,
        payload: campaign
      });

      return reply.code(201).send(campaign);
    } catch (error) {
      return handleCampaignsError(reply, error);
    }
  });

  app.patch("/campaigns/:campaignId", async (request, reply) => {
    if (!requireCampaignManage(request.talk.role, reply)) {
      return reply;
    }

    const params = campaignParamsSchema.safeParse(request.params);
    const body = updateCampaignBodySchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid campaign request." });
    }

    try {
      const campaign = await service.updateCampaign({
        workspaceId: request.talk.workspaceId,
        campaignId: params.data.campaignId,
        data: body.data
      });

      app.realtime.publish({
        type: "campaign.updated",
        workspaceId: request.talk.workspaceId,
        payload: campaign
      });

      return campaign;
    } catch (error) {
      return handleCampaignsError(reply, error);
    }
  });

  app.post("/campaigns/:campaignId/resolve-audience", async (request, reply) => {
    const params = campaignParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid campaign request." });
    }

    try {
      return await service.resolveAudience({
        workspaceId: request.talk.workspaceId,
        campaignId: params.data.campaignId
      });
    } catch (error) {
      return handleCampaignsError(reply, error);
    }
  });

  app.post("/campaigns/:campaignId/preview-audience", async (request, reply) => {
    if (!requireCampaignManage(request.talk.role, reply)) return reply;
    const params = campaignParamsSchema.safeParse(request.params);
    const body = z.object({ channelId: uuidParamSchema,
      startMode: z.enum(["now", "scheduled"]).optional(),
      scheduledAt: z.string().datetime().nullable().optional(),
      timeZone: z.string().min(1).max(100).optional()
    }).safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Escolha um canal de envio válido." });
    }
    try {
      return await verifiedPreview(request.talk.workspaceId, params.data.campaignId,
        body.data.channelId, body.data.startMode && body.data.timeZone ? {
          startMode: body.data.startMode, scheduledAt: body.data.scheduledAt,
          timeZone: body.data.timeZone
        } : undefined);
    } catch (error) {
      return handleCampaignsError(reply, error);
    }
  });

  app.post("/campaigns/:campaignId/activate", async (request, reply) => {
    if (!requireCampaignManage(request.talk.role, reply)) return reply;
    const params = campaignParamsSchema.safeParse(request.params);
    const body = z.object({
      idempotencyKey: uuidParamSchema, channelId: uuidParamSchema,
      startMode: z.enum(["now", "scheduled"]),
      scheduledAt: z.string().datetime().nullable(),
      timeZone: z.string().min(1).max(100),
      confirmation: z.literal(true),
      expectedAudienceHash: z.string().regex(/^[a-f0-9]{64}$/)
    }).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({
      error: "Revise os destinatários, a mensagem e o horário antes de confirmar." });
    try {
      const previous = await app.prisma.campaign.findFirst({ where: {
        id: params.data.campaignId, workspaceId: request.talk.workspaceId,
        activationKey: body.data.idempotencyKey
      }, select: { id: true, status: true, scheduledAt: true } });
      if (previous) return { campaignId: previous.id, status: previous.status,
        recipientsQueued: await app.prisma.campaignRecipient.count({ where: {
          workspaceId: request.talk.workspaceId, campaignId: previous.id,
          status: { not: "queued_simulated" } } }),
        scheduledAt: previous.scheduledAt?.toISOString() ?? null };
      const preview = await verifiedPreview(request.talk.workspaceId, params.data.campaignId,
        body.data.channelId);
      const activated = await activation.activate({ ...body.data, preview,
        campaignId: params.data.campaignId,
        workspaceId: request.talk.workspaceId,
        actorId: request.talk.clerkUserId ?? request.talk.workspaceId });
      return { campaignId: activated.id, status: activated.status,
        recipientsQueued: preview.eligible.length, scheduledAt: activated.scheduledAt?.toISOString() ?? null };
    } catch (error) {
      if (error instanceof CampaignActivationError) return reply.code(
        error.code === "CAMPAIGN_NOT_FOUND" ? 404 : 409).send({ code: error.code,
          error: error.message });
      return handleCampaignsError(reply, error);
    }
  });

  app.get("/campaigns/:campaignId/progress", async (request, reply) => {
    const params = campaignParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Campanha inválida." });
    try {
      return await controls.progress(request.talk.workspaceId, params.data.campaignId);
    } catch (error) {
      if (error instanceof CampaignControlError) return reply.code(404).send({
        code: error.code, error: error.message });
      throw error;
    }
  });

  for (const [path, action] of [
    ["pause", controls.pause.bind(controls)],
    ["resume", controls.resume.bind(controls)],
    ["cancel-remaining", controls.cancelRemaining.bind(controls)]
  ] as const) {
    app.post(`/campaigns/:campaignId/${path}`, async (request, reply) => {
      if (!requireCampaignManage(request.talk.role, reply)) return reply;
      const params = campaignParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Campanha inválida." });
      try {
        return await action(request.talk.workspaceId, params.data.campaignId);
      } catch (error) {
        if (error instanceof CampaignControlError) return reply.code(
          error.code === "CAMPAIGN_NOT_FOUND" ? 404 : 409).send({
            code: error.code, error: error.message });
        throw error;
      }
    });
  }

  app.post("/campaigns/:campaignId/recipients/:recipientId/resolve-uncertain", async (request, reply) => {
    if (!requireCampaignManage(request.talk.role, reply)) return reply;
    const params = campaignRecipientParamsSchema.safeParse(request.params);
    const body = z.object({ outcome: z.enum(["sent", "not_sent"]),
      confirmation: z.literal(true) }).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({
      error: "Confirme o resultado depois de verificar a conversa no WhatsApp." });
    try {
      return await controls.resolveUncertain({ workspaceId: request.talk.workspaceId,
        campaignId: params.data.campaignId, recipientId: params.data.recipientId,
        actorId: request.talk.clerkUserId ?? request.talk.workspaceId,
        outcome: body.data.outcome });
    } catch (error) {
      if (error instanceof CampaignControlError) return reply.code(
        error.code === "CAMPAIGN_NOT_FOUND" ? 404 : 409).send({
          code: error.code, error: error.message });
      throw error;
    }
  });

  app.post("/campaigns/:campaignId/send-simulated", async (request, reply) => {
    if (!requireCampaignManage(request.talk.role, reply)) {
      return reply;
    }

    const params = campaignParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid campaign request." });
    }

    try {
      const result = await service.sendSimulated({
        workspaceId: request.talk.workspaceId,
        campaignId: params.data.campaignId
      });
      const campaign = await service.getCampaign({
        workspaceId: request.talk.workspaceId,
        campaignId: params.data.campaignId
      });

      app.realtime.publish({
        type: "campaign.updated",
        workspaceId: request.talk.workspaceId,
        payload: campaign
      });

      return result;
    } catch (error) {
      return handleCampaignsError(reply, error);
    }
  });

  app.post("/campaigns/:campaignId/send-real", async (request, reply) => {
    if (!requireCampaignManage(request.talk.role, reply)) {
      return reply;
    }

    const params = campaignParamsSchema.safeParse(request.params);
    const body = sendRealBodySchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid campaign request." });
    }

    return reply.code(409).send({ code: "CAMPAIGN_REVIEW_REQUIRED",
      error: "Revise os destinatários e a mensagem antes de ativar o envio." });
  });

  app.post("/campaigns/:campaignId/send-meta-template", async (request, reply) => {
    if (!requireCampaignManage(request.talk.role, reply)) {
      return reply;
    }

    const params = campaignParamsSchema.safeParse(request.params);
    const body = sendMetaTemplateBodySchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid campaign request." });
    }

    try {
      const runtime = await resolveMetaRuntime(app.prisma, {
        workspaceId: request.talk.workspaceId
      });
      const metaService = createCampaignsService(app.prisma as unknown as PrismaLike, {
        evolution: options.evolution,
        meta: {
          phoneNumberId: runtime.phoneNumberId,
          wabaId: runtime.wabaId,
          client: runtime.client
        },
        metaEvolution: {
          instanceName: runtime.evolutionInstanceName,
          client: runtime.evolutionClient?.sendTemplate ? {
            sendTemplate: runtime.evolutionClient.sendTemplate.bind(runtime.evolutionClient)
          } : null
        }
      });
      const result = await metaService.sendMetaTemplate({
        workspaceId: request.talk.workspaceId,
        campaignId: params.data.campaignId,
        channelId: body.data.channelId,
        channelIds: body.data.channelIds,
        template: body.data.template
      });
      const campaign = await service.getCampaign({
        workspaceId: request.talk.workspaceId,
        campaignId: params.data.campaignId
      });

      app.realtime.publish({
        type: "campaign.updated",
        workspaceId: request.talk.workspaceId,
        payload: campaign
      });

      return result;
    } catch (error) {
      return handleCampaignsError(reply, error);
    }
  });

  app.get("/campaigns/:campaignId/recipients", async (request, reply) => {
    const params = campaignParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid campaign request." });
    }

    try {
      return await service.listRecipients({
        workspaceId: request.talk.workspaceId,
        campaignId: params.data.campaignId
      });
    } catch (error) {
      return handleCampaignsError(reply, error);
    }
  });
};
