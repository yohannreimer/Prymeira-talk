import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import type { AppEnv } from "./env.js";
import { authContextPlugin } from "./plugins/auth-context.js";
import type { AuthContextPluginOptions } from "./plugins/auth-context.js";
import { prismaPlugin } from "./plugins/prisma.js";
import { inboxTimingPlugin } from "./plugins/inbox-timing.js";
import { cnpjDatabasePlugin } from "./plugins/cnpj-database.js";
import { createAgentFollowupRuntime } from "./modules/agents/agent-followup-runtime.js";
import { createAgentRuntime } from "./modules/agents/agent-runtime.js";
import { createJevFollowupDecision } from "./modules/agents/jev-followup-decision.js";
import { createJevFollowupEligibility } from "./modules/followups/jev-followup-eligibility.js";
import { createLunaFollowupEligibility } from "./modules/followups/luna-followup-eligibility.js";
import { createJevReplyPreflight } from "./modules/agents/jev-reply-preflight.js";
import {
  createJevAgentImprovementDetector,
  createJevAgentImprovementNormalizer
} from "./modules/agents/jev-agent-improvement.js";
import { createAgentImprovementsService } from "./modules/agents/agent-improvements.service.js";
import { createLunaAgentImprovementDetector } from "./modules/agents/luna-agent-improvement.js";
import { createOpenAiAgentImprovementRuleWriter } from "./modules/agents/openai-agent-improvement.js";
import { createAgentReplyScheduler } from "./modules/agents/agent-reply-scheduler.js";
import { createConversationFollowupScheduler } from "./modules/followups/conversation-followup-scheduler.js";
import { createConversationFollowupsService } from "./modules/followups/conversation-followups.service.js";
import { createConversationFollowupRealtimePublisher } from "./modules/followups/conversation-followup-events.js";
import { agentsRoutes } from "./modules/agents/agents.routes.js";
import { agentPackageRoutes } from "./modules/agents/agent-package.routes.js";
import { createSimulatedAgentProvider } from "./modules/agents/provider-gateway.js";
import { automationsRoutes } from "./modules/automations/automations.routes.js";
import { assistantRoutes } from "./modules/assistant/assistant.routes.js";
import { createAssistantScheduler } from './modules/assistant/assistant-scheduler.js';
import { createAssistantGeneration } from './modules/assistant/assistant-generation.js';
import { createAssistantHistoryImporter } from './modules/assistant/assistant-history.js';
import { createEvolutionHistorySource } from './modules/evolution/evolution-history.js';
import { prepareInboundMedia } from './modules/agents/inbound-media.js';
import { resolveOpenAiCompatibleSettings } from './modules/agents/ai-provider-settings.js';
import { assistantInboxRoutes } from './modules/assistant/assistant-inbox.routes.js';
import { createHandoffBriefService } from './modules/assistant/handoff-brief-service.js';
import { createBoardRulesService, type BoardRulesPrismaLike } from "./modules/boards/board-rules.service.js";
import { boardsRoutes } from "./modules/boards/boards.routes.js";
import { campaignsRoutes } from "./modules/campaigns/campaigns.routes.js";
import { broadcastListsRoutes } from './modules/campaigns/broadcast-lists.routes.js';
import { createCampaignWorker } from "./modules/campaigns/campaign-worker.js";
import { channelsRoutes } from "./modules/channels/channels.routes.js";
import { createChannelWatchdog, type ChannelWatchdogPrisma } from "./modules/channels/channel-watchdog.js";
import { createChannelHistoryImporter, createChannelHistoryImportScheduler } from "./modules/channels/channel-history-import.js";
import { createCreatedMessagesNotifier } from "./modules/channels/created-messages-notifier.js";
import { createContactNameRecoverySchedulerIfEnabled } from "./modules/channels/contact-name-recovery-scheduler.js";
import { contactsRoutes } from "./modules/contacts/contacts.routes.js";
import {
  createConversationsService,
  type ConversationOutboundTextDelivery,
  type PrismaLike as ConversationsPrismaLike
} from "./modules/conversations/conversations.service.js";
import { conversationsRoutes } from "./modules/conversations/conversations.routes.js";
import { createInboxTriageService } from "./modules/conversations/inbox-triage.service.js";
import { createInboxTriageClassifier, createJevInboxTriage, createLunaInboxTriage } from "./modules/conversations/inbox-triage-model.js";
import { createInboxTriageScheduler } from "./modules/conversations/inbox-triage-scheduler.js";
import { inboxTriageRoutes } from "./modules/conversations/inbox-triage.routes.js";
import { createRealtimeOutboundDelivery } from "./modules/conversations/realtime-outbound-delivery.js";
import { conversationFollowupsRoutes } from "./modules/followups/conversation-followups.routes.js";
import { createEvolutionRuntime } from "./modules/evolution/evolution-runtime.js";
import { createWahaRuntime } from './modules/waha/waha.client.js';
import { createDurableMedia } from './modules/conversations/durable-media.js';
import { createOutboundRouter } from './modules/channels/outbound-router.js';
import { createChannelHealthMonitor } from './modules/channels/channel-health-monitor.js';
import { createChannelConnectionsService } from './modules/channels/channel-connections.js';
import { createOutboundDispatchJournal } from './modules/channels/outbound-dispatch-journal.js';
import { createDeliveryProbe } from './modules/channels/outbound-probes.js';
import { outboundReviewRoutes } from './modules/channels/outbound-review.routes.js';
import { conversationAuthorityRoutes } from './modules/channels/conversation-authority.routes.js';
import { historyComparisonRoutes } from './modules/channels/history-comparison.routes.js';
import { createWahaLidResolver } from './modules/waha/waha-lid-resolver.js';
import { createEffectRunner, startEffectLoop } from './modules/ingress/effect-runner.js';
import { createEffectHandlers } from './modules/ingress/effect-handlers.js';
import { createMediaPrepareHandler, createSourceMediaPreparer } from './modules/ingress/media-prepare-handler.js';
import { createAutomationRunner, type AutomationRunnerPrisma } from './modules/automations/automation-runner.js';
import { crmRoutes } from "./modules/crm/crm.routes.js";
import { evolutionRoutes } from "./modules/evolution/evolution.routes.js";
import { resolveMetaRuntime } from "./modules/meta/meta-runtime.js";
import { metaWebhooksRoutes } from "./modules/meta/meta.webhooks.routes.js";
import { realtimeRoutes } from "./modules/realtime/realtime.routes.js";
import { reportsRoutes } from "./modules/reports/reports.routes.js";
import { settingsRoutes } from "./modules/settings/settings.routes.js";
import { supervisionRoutes } from "./modules/supervision/supervision.routes.js";
import { tagsRoutes } from "./modules/tags/tags.routes.js";
import { teamRoutes } from "./modules/team/team.routes.js";
import { quickRepliesRoutes } from "./modules/quick-replies/quick-replies.routes.js";
import { uploadsRoutes } from "./modules/uploads/uploads.routes.js";
import { CnpjRepository } from "./modules/leads/cnpj.repository.js";
import { LeadsRepository } from "./modules/leads/leads.repository.js";
import { createLeadsService } from "./modules/leads/leads.service.js";
import { createLeadsScheduler } from "./modules/leads/leads.scheduler.js";
import { leadsRoutes } from "./modules/leads/leads.routes.js";
import { createCityGeocoder } from "./modules/leads/city-geocoder.js";
import { createGoogleMapsScraperClient } from "./modules/leads/google-maps-scraper.client.js";

export interface CreateAppOptions {
  authEnabled?: boolean;
  fetch?: AuthContextPluginOptions["fetch"];
  logger?: boolean;
  prismaEnabled?: boolean;
  readinessCheck?: () => Promise<void>;
  requireProductAccess?: AuthContextPluginOptions["requireProductAccess"];
}

export async function createApp(env: AppEnv, options: CreateAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true, trustProxy: true });
  await app.register(inboxTimingPlugin);
  const allowedCorsOrigins = env.CORS_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  await app.register(cors, {
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    origin(origin, callback) {
      if (!origin || allowedCorsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(null, false);
    }
  });

  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_TIME_WINDOW,
    errorResponseBuilder(_request, context) {
      const error = new Error(`Too many requests. Try again in ${context.after}.`);
      (error as Error & { statusCode: number }).statusCode = context.statusCode;
      return error;
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    const maybeHttpError = error as Error & { statusCode?: number };
    if (maybeHttpError.statusCode === 429) {
      return reply.status(429).send({
        error: {
          code: "RATE_LIMITED",
          message: maybeHttpError.message
        }
      });
    }

    return reply.send(error);
  });

  if (options.prismaEnabled !== false) {
    await app.register(prismaPlugin, { databaseUrl: env.DATABASE_URL });
  }

  if (env.CNPJ_DATABASE_URL) {
    await app.register(cnpjDatabasePlugin, { databaseUrl: env.CNPJ_DATABASE_URL });
  }

  if (options.authEnabled !== false) {
    await app.register(authContextPlugin, {
      accountApiUrl: env.PRYMEIRA_ACCOUNT_API_URL,
      productKey: env.PRYMEIRA_PRODUCT_KEY,
      localAuthBypass: env.PRYMEIRA_LOCAL_AUTH_BYPASS
        ? {
            workspaceId: env.PRYMEIRA_LOCAL_WORKSPACE_ID,
            role: env.PRYMEIRA_LOCAL_ROLE
          }
        : undefined,
      fetch: options.fetch,
      requireProductAccess: options.requireProductAccess
    });
  }

  app.get("/health", async () => ({ ok: true, product: env.PRYMEIRA_PRODUCT_KEY }));
  app.get("/ready", async (_request, reply) => {
    try {
      if (options.readinessCheck) {
        await options.readinessCheck();
      } else {
        await app.prisma.$queryRawUnsafe("SELECT 1");
      }
      return { ok: true, product: env.PRYMEIRA_PRODUCT_KEY };
    } catch {
      return reply.code(503).send({ ok: false, product: env.PRYMEIRA_PRODUCT_KEY });
    }
  });
  app.get("/me", async (request) => ({
    workspaceId: request.talk.workspaceId,
    role: request.talk.role
  }));

  await app.register(realtimeRoutes, { bridgeDatabaseUrl: env.REALTIME_BRIDGE_ENABLED ? env.DATABASE_URL : undefined });
  const followupPublisher = createConversationFollowupRealtimePublisher(app.realtime);
  if (!env.JEV_API_KEY) {
    app.log.warn("JEV_API_KEY is unavailable; contextual follow-up selection and delivery are disabled.");
  }

  const evolutionRuntime = createEvolutionRuntime({
    mode: env.EVOLUTION_MODE,
    publicTalkUrl: env.PUBLIC_TALK_URL,
    localTalkUrl: env.LOCAL_TALK_URL,
    apiBaseUrl: env.EVOLUTION_API_BASE_URL,
    apiKey: env.EVOLUTION_API_KEY,
    webhookSecret: env.EVOLUTION_WEBHOOK_SECRET
  });
  // Staged rollout: only these workspaces see WAHA, the new router, canonical history and durable media copies.
  const rollout = env.WAHA_ROLLOUT_WORKSPACES;
  const inRollout = (workspaceId: string) => rollout === '*' || rollout.has(workspaceId);
  const wahaRuntime = createWahaRuntime({ enabled: env.WAHA_ENABLED, baseUrl: env.WAHA_API_BASE_URL, apiKey: env.WAHA_API_KEY, webhookBaseUrl: env.WAHA_WEBHOOK_BASE_URL, webhookHmacKey: env.WAHA_WEBHOOK_HMAC_KEY, allows: inRollout });
  // Opt-in single outbound router: every sender already sends through evolutionRuntime.client, so wrapping it here
  // routes human, AI, automation, follow-up and campaign sends through one journal and one failover policy.
  let outboundJournal: ReturnType<typeof createOutboundDispatchJournal> | undefined;
  if (options.prismaEnabled !== false && env.OUTBOUND_ROUTER_ENABLED && evolutionRuntime.client) {
    outboundJournal = createOutboundDispatchJournal(app.prisma);
    evolutionRuntime.client = createOutboundRouter({
      base: evolutionRuntime.client, waha: wahaRuntime.client, db: app.prisma, journal: outboundJournal,
      probe: createDeliveryProbe({ waha: wahaRuntime.client, history: { recentMessages: (input) => { if (!evolutionHistorySource) throw new Error('HISTORY_UNAVAILABLE'); return evolutionHistorySource.recentMessages(input); } } }),
      logger: app.log,
      routes: inRollout
    });
    const sweeper = setInterval(() => { void outboundJournal!.sweepStale().catch((error: unknown) => app.log.warn({ err: error }, 'Outbound journal sweep failed')); }, 60_000);
    sweeper.unref();
    app.addHook('onClose', async () => { clearInterval(sweeper); });
  }
  // Opt-in durable media + shared transcription job. Without TALK_MEDIA_STORE_PATH nothing changes.
  const durableMedia = options.prismaEnabled !== false && env.TALK_MEDIA_STORE_PATH
    ? await createDurableMedia({ prisma: app.prisma, root: env.TALK_MEDIA_STORE_PATH, appliesTo: inRollout })
    : undefined;

  const leadsRepository = options.prismaEnabled === false
    ? undefined
    : new LeadsRepository(app.prisma);
  const leadsService = leadsRepository
    ? createLeadsService({
        repository: leadsRepository,
        cnpjRepository: new CnpjRepository(app.cnpj),
        googleMapsClient: env.GOOGLE_MAPS_SCRAPER_URL
          ? createGoogleMapsScraperClient({
              baseUrl: env.GOOGLE_MAPS_SCRAPER_URL,
              depth: env.LEAD_GOOGLE_DEFAULT_DEPTH
            })
          : undefined,
        cityGeocoder: createCityGeocoder(),
        evolutionClient: evolutionRuntime.client?.checkWhatsappNumbersAvailability
          ? {
              checkWhatsappNumbersAvailability: evolutionRuntime.client.checkWhatsappNumbersAvailability.bind(evolutionRuntime.client)
            }
          : null,
        googlePollIntervalMs: env.LEAD_JOB_POLL_MS,
        realtime: app.realtime
      })
    : undefined;
  const leadsScheduler = leadsRepository && leadsService
    ? createLeadsScheduler({
        repository: leadsRepository,
        service: leadsService,
        pollIntervalMs: env.LEAD_JOB_POLL_MS,
        maxGoogleConcurrentJobs: env.LEAD_GOOGLE_MAX_CONCURRENT_JOBS,
        onError: (error) => app.log.error({ err: error }, "Leads scheduler failed; jobs remain persisted.")
      })
    : undefined;
  leadsScheduler?.start();
  if (leadsScheduler) {
    app.addHook("onClose", async () => {
      await leadsScheduler.stop();
    });
  }
  if (leadsService) {
    await app.register(leadsRoutes, { service: leadsService, publicTalkUrl: env.PUBLIC_TALK_URL });
  }

  const evolutionHistorySource =
    evolutionRuntime.mode === "real" && env.EVOLUTION_API_BASE_URL && env.EVOLUTION_API_KEY
      ? createEvolutionHistorySource({
          baseUrl: env.EVOLUTION_API_BASE_URL,
          apiKey: env.EVOLUTION_API_KEY
        })
      : undefined;
  // Canonical history import: durable media for imported attachments and live updates for open inboxes.
  const historyAfter = options.prismaEnabled === false ? undefined : {
    prepareMedia: durableMedia ? createSourceMediaPreparer({ media: durableMedia.media, waha: wahaRuntime.client, evolution: evolutionRuntime.client ?? null }) : undefined,
    notify: createCreatedMessagesNotifier(app.prisma, (event) => app.realtime.publish(event))
  };
  const channelHistoryImportScheduler = options.prismaEnabled === false || !evolutionHistorySource
    ? undefined
    : createChannelHistoryImportScheduler({
        prisma: app.prisma,
        source: evolutionHistorySource,
        canonical: env.CANONICAL_HISTORY_IMPORT_ENABLED ? inRollout : false,
        after: historyAfter,
        async onConversation(workspaceId, conversationId) {
          const conversation = await createConversationsService(app.prisma as unknown as ConversationsPrismaLike)
            .getConversationDto({ workspaceId, conversationId });
          app.realtime.publish({ type: "conversation.updated", workspaceId, payload: conversation });
        },
        onError(error, channelId) { app.log.error({ err: error, channelId }, "Channel history import failed; retry scheduled."); },
        onComplete(channelId, conversations, messages) { app.log.info({ channelId, conversations, messages }, "Channel history import completed."); }
      });
  channelHistoryImportScheduler?.start();
  if (channelHistoryImportScheduler) app.addHook("onClose", async () => { await channelHistoryImportScheduler.stop(); });
  const contactNameRecoveryScheduler = createContactNameRecoverySchedulerIfEnabled({
    enabled: env.CONTACT_NAME_RECOVERY_ENABLED,
    prisma: options.prismaEnabled === false ? undefined : app.prisma,
    source: evolutionHistorySource,
    onResult(workspaceId, result) { app.log.info({ workspaceId, ...result }, "contact_name_recovery"); },
    onError(error, workspaceId) { app.log.error({ err: error, workspaceId }, "Contact name recovery failed."); }
  });
  contactNameRecoveryScheduler?.start();
  if (contactNameRecoveryScheduler) app.addHook("onClose", async () => { await contactNameRecoveryScheduler.stop(); });
  const channelWatchdog = env.CHANNEL_WATCHDOG_ENABLED && options.prismaEnabled !== false &&
    evolutionRuntime.mode === "real" && evolutionRuntime.client
    ? createChannelWatchdog({
        prisma: app.prisma as unknown as ChannelWatchdogPrisma,
        evolution: {
          client: evolutionRuntime.client,
          webhookSecret: evolutionRuntime.webhookSecret,
          publicWebhookUrl: evolutionRuntime.publicWebhookUrl
        },
        publish: (event) => app.realtime.publish(event),
        intervalMs: env.CHANNEL_WATCHDOG_INTERVAL_SECONDS * 1000,
        dryRun: env.CHANNEL_WATCHDOG_DRY_RUN,
        log: app.log
      })
    : undefined;
  if (channelWatchdog) {
    app.log.info({ event: "channel_watchdog_started", dryRun: env.CHANNEL_WATCHDOG_DRY_RUN, intervalSeconds: env.CHANNEL_WATCHDOG_INTERVAL_SECONDS }, "Channel watchdog started.");
  }
  channelWatchdog?.start();
  if (channelWatchdog) app.addHook("onClose", async () => { await channelWatchdog.stop(); });
  const lunaEligibility = options.prismaEnabled === false
    ? undefined
    : createLunaFollowupEligibility({ prisma: app.prisma });
  const jevEligibility = env.JEV_API_KEY
    ? createJevFollowupEligibility({ apiKey: env.JEV_API_KEY, model: env.JEV_MODEL })
    : undefined;
  const inboxTriage = options.prismaEnabled === false
    ? undefined : createInboxTriageService(app.prisma);
  const lunaImprovementDetector = options.prismaEnabled === false
    ? undefined
    : createLunaAgentImprovementDetector({ prisma: app.prisma });
  const jevImprovementDetector = env.JEV_API_KEY
    ? createJevAgentImprovementDetector({ apiKey: env.JEV_API_KEY, model: env.JEV_MODEL })
    : undefined;
  const followupService =
    options.prismaEnabled === false
      ? undefined
      : createConversationFollowupsService(
          app.prisma as unknown as Parameters<typeof createConversationFollowupsService>[0],
          {
            publisher: followupPublisher,
            screeningRequired: true,
            eligibility: {
              async evaluate(candidate) {
                try {
                  return await lunaEligibility!.evaluate(candidate);
                } catch (error) {
                  if (!jevEligibility) throw error;
                  app.log.warn({ err: error }, "GPT-6 Luna follow-up screening unavailable; using JEV");
                  return jevEligibility.evaluate(candidate);
                }
              }
            }
          }
        );
  const replyPreflight = env.JEV_API_KEY
    ? createJevReplyPreflight({ apiKey: env.JEV_API_KEY, model: env.JEV_MODEL })
    : undefined;
  const agentImprovements = options.prismaEnabled === false
    ? undefined
    : createAgentImprovementsService(
        app.prisma as unknown as Parameters<typeof createAgentImprovementsService>[0],
        {
          detector: {
            async assess(observation) {
              try {
                return await lunaImprovementDetector!.assess(observation);
              } catch (error) {
                if (!jevImprovementDetector) throw error;
                app.log.warn({ err: error }, "GPT-6 Luna improvement detection unavailable; using JEV");
                return jevImprovementDetector.assess(observation);
              }
            }
          },
          ...(env.JEV_API_KEY ? {
            normalizer: createJevAgentImprovementNormalizer({
              apiKey: env.JEV_API_KEY,
              model: env.JEV_MODEL
            })
          } : {}),
          writer: createOpenAiAgentImprovementRuleWriter({ prisma: app.prisma })
        }
      );
  const handoffBriefService = options.prismaEnabled === false ? undefined : createHandoffBriefService(app.prisma);
  const agentRuntime =
    options.prismaEnabled === false
      ? undefined
      : createAgentRuntime({
          prisma: app.prisma as unknown as Parameters<typeof createAgentRuntime>[0]["prisma"],
          provider: createSimulatedAgentProvider(),
          replyPreflight,
          evolution: evolutionRuntime,
          chatHistory: evolutionHistorySource,
          realtime: app.realtime,
          logger: app.log,
          boardRules: createBoardRulesService(app.prisma as unknown as BoardRulesPrismaLike),
          followupService,
          inboxTriage,
          handoffBriefService,
          durableMedia: durableMedia?.media,
          transcriptions: durableMedia?.transcriptions
        });
  const agentReplyScheduler =
    options.prismaEnabled === false || !agentRuntime
      ? undefined
      : createAgentReplyScheduler({
          prisma: app.prisma as unknown as Parameters<typeof createAgentReplyScheduler>[0]["prisma"],
          agentRuntime,
          followupService
        });
  agentReplyScheduler?.start();
  if (agentReplyScheduler) {
    app.addHook("onClose", async () => {
      agentReplyScheduler.stop();
    });
  }

  // Both automatic and human-reviewed follow-ups must use the same provider
  // resolution and durable outbound-message path as a normal Talk reply.
  const rawFollowupOutbound: ConversationOutboundTextDelivery | undefined =
    options.prismaEnabled === false
      ? undefined
      : {
          async createPendingOutboundMessage(deliveryInput) {
            const meta = await resolveMetaRuntime(app.prisma, {
              workspaceId: deliveryInput.workspaceId
            });
            return createConversationsService(
              app.prisma as unknown as ConversationsPrismaLike,
              {
                evolution: evolutionRuntime,
                meta: {
                  client: meta.client,
                  phoneNumberId: meta.phoneNumberId
                },
                metaEvolution: {
                  client: meta.evolutionClient?.sendText
                    ? { sendText: meta.evolutionClient.sendText.bind(meta.evolutionClient) }
                    : null
                }
              }
            ).createPendingOutboundMessage(deliveryInput);
          }
        };
  const followupOutbound = rawFollowupOutbound
    ? createRealtimeOutboundDelivery({ delivery: rawFollowupOutbound, realtime: app.realtime })
    : undefined;

  const followupRuntime =
    options.prismaEnabled === false || !followupService || !followupOutbound || !env.JEV_API_KEY
      ? undefined
      : createAgentFollowupRuntime({
          prisma: app.prisma as unknown as Parameters<typeof createAgentFollowupRuntime>[0]["prisma"],
          provider: createSimulatedAgentProvider(),
          allowFallbackProvider: false,
          followups: followupService,
          jevFollowupDecision: createJevFollowupDecision({
            apiKey: env.JEV_API_KEY,
            model: env.JEV_MODEL
          }),
          replyPreflight,
          outbound: followupOutbound,
          publisher: followupPublisher
        });
  const conversationFollowupScheduler = followupService
    ? createConversationFollowupScheduler({
        prisma: app.prisma as unknown as Parameters<typeof createConversationFollowupScheduler>[0]["prisma"],
        runtime: followupRuntime,
        evaluator: followupService,
        reconciler: followupService,
        onError(error, followup) {
          app.log.error(
            {
              err: error,
              ...(followup
                ? { followupId: followup.id, workspaceId: followup.workspaceId }
                : {})
            },
            followup
              ? "Conversation follow-up scheduler failed."
              : "Conversation follow-up polling failed."
          );
        }
      })
    : undefined;
  conversationFollowupScheduler?.start();
  if (conversationFollowupScheduler) {
    // Fastify closes hooks in reverse registration order, before the earlier
    // Prisma plugin hook disconnects the database client.
    app.addHook("onClose", async () => {
      await conversationFollowupScheduler.stop();
    });
  }

  const inboxTriageScheduler = options.prismaEnabled === false || !inboxTriage || !env.INBOX_TRIAGE_ENABLED
    ? undefined
    : createInboxTriageScheduler({
        prisma: app.prisma,
        observer: inboxTriage,
        classifier: createInboxTriageClassifier({
          primary: env.INBOX_TRIAGE_PRIMARY,
          luna: createLunaInboxTriage({ prisma: app.prisma }),
          ...(env.JEV_API_KEY ? { jev: createJevInboxTriage({ apiKey: env.JEV_API_KEY, model: env.JEV_MODEL }) } : {})
        }),
        async onUpdate(workspaceId, conversationId) {
          const conversation = await createConversationsService(app.prisma as unknown as ConversationsPrismaLike)
            .getConversationDto({ workspaceId, conversationId });
          app.realtime.publish({ type: "conversation.updated", workspaceId, payload: conversation });
        },
        onError(error, conversationId) {
          app.log.error({ err: error, conversationId }, "Inbox triage scheduler failed");
        }
      });
  inboxTriageScheduler?.start();
  if (inboxTriageScheduler) {
    app.addHook("onClose", async () => { await inboxTriageScheduler.stop(); });
  }

  const prepareAssistantHistory = options.prismaEnabled === false || !evolutionHistorySource
    ? undefined
    : createAssistantHistoryImporter(app.prisma, evolutionHistorySource, {
        prepareMedia: async ({ workspaceId, mediaUrl, kind }) => prepareInboundMedia({ settings: await resolveOpenAiCompatibleSettings(app.prisma, { workspaceId }), mediaUrl, kind })
      });
  const assistantScheduler = options.prismaEnabled === false ? undefined : createAssistantScheduler(app.prisma, { generate: createAssistantGeneration(app.prisma, { durableMedia: durableMedia?.media, transcriptions: durableMedia?.transcriptions }), prepareContext: prepareAssistantHistory, onError: () => app.log.error('Assistant scheduler failed; drafts remain private.') });
  assistantScheduler?.start();
  app.addHook('onClose', async () => { assistantScheduler?.stop(); handoffBriefService?.stop(); });
  const historyBackfill = options.prismaEnabled === false || !evolutionHistorySource ? undefined : async (input: { workspaceId: string; channelId: string; conversationId: string; providerKey: string; remoteJid: string; identity: string; pushName: string | null }) => {
    const count = await app.prisma.message.count({ where: { workspaceId: input.workspaceId, conversationId: input.conversationId } });
    if (count >= 30) return;
    const importer = createChannelHistoryImporter({ prisma: app.prisma, source: evolutionHistorySource, canonical: env.CANONICAL_HISTORY_IMPORT_ENABLED ? inRollout : false, after: historyAfter });
    await importer.importChat({ id: input.channelId, workspaceId: input.workspaceId,
      providerKey: input.providerKey, historyImportAttempts: 0 },
    { remoteJid: input.remoteJid, phoneJid: input.identity, pushName: input.pushName, profilePicUrl: null }, 30);
  };
  await app.register(evolutionRoutes, {
    waha: wahaRuntime,
    messageHistory: evolutionHistorySource,
    historyBackfill,
    assistantScheduler,
    handoffBriefService,
    webhookSecret: env.EVOLUTION_WEBHOOK_SECRET,
    delegatedWorkspaces: env.LEGACY_WEBHOOK_DELEGATED_WORKSPACES,
    followupService,
    inboxTriage,
    agentImprovements,
    agentRuntime,
    agentReplyScheduler,
    evolution: evolutionRuntime,
    durableMedia: durableMedia?.media,
    durableMediaWorkspaces: inRollout,
    evolutionClient: evolutionRuntime.client
  });
  // Durable ingress effects: the observable consequences of a message accepted by the new ingress (assistant,
  // agent, follow-ups, triage, automations, realtime). Off by default; the legacy webhook does them inline.
  if (options.prismaEnabled !== false && env.EFFECTS_ENABLED) {
    const automationRunner = createAutomationRunner({
      prisma: app.prisma as unknown as AutomationRunnerPrisma,
      agentRuntime, agentReplyScheduler, evolution: evolutionRuntime, realtime: app.realtime,
      boardRules: createBoardRulesService(app.prisma as unknown as BoardRulesPrismaLike)
    });
    const handlers = createEffectHandlers({
      db: app.prisma, realtime: app.realtime, assistantScheduler, handoffBriefService, inboxTriage, followupService,
      agentImprovements, agentRuntime, agentReplyScheduler, automationRunner, historyBackfill,
      groupSubject: async ({ provider, sessionName, groupJid }) => provider === 'waha'
        ? (await wahaRuntime.client?.getGroup({ session: sessionName, groupId: groupJid }))?.subject ?? null
        : (await evolutionRuntime.client?.getGroupInfo?.({ instanceName: sessionName, groupJid }))?.subject ?? null,
      logger: app.log
    });
    if (durableMedia) {
      // Any process can prepare media: the effect carries the provider identifiers it needs.
      handlers['media.prepare'] = createMediaPrepareHandler({ media: durableMedia.media, waha: wahaRuntime.client, evolution: evolutionRuntime.client ?? null });
    }
    const runner = createEffectRunner({ db: app.prisma, workerId: `api-${process.pid}-${Math.random().toString(36).slice(2, 8)}`, handlers,
      ...(env.EFFECTS_WORKSPACE_ALLOWLIST.length ? { workspaceIds: env.EFFECTS_WORKSPACE_ALLOWLIST } : {}), logger: app.log });
    const effectsAbort = new AbortController();
    const effectsLoop = startEffectLoop(runner, { signal: effectsAbort.signal, onError: (error) => app.log.error({ err: error }, 'Ingress effect loop iteration failed') });
    app.addHook('onClose', async () => { effectsAbort.abort(); await effectsLoop; });
  }
  await app.register(metaWebhooksRoutes, { assistantScheduler, handoffBriefService, inboxTriage, delegatedWorkspaces: env.LEGACY_WEBHOOK_DELEGATED_WORKSPACES });
  await app.register(conversationsRoutes, {
    publicTalkUrl: env.PUBLIC_TALK_URL,
    evolution: evolutionRuntime,
    messageHistory: evolutionHistorySource,
    assistantScheduler,
    handoffBriefService,
    followupService,
    inboxTriage,
    agentImprovements,
    durableMedia: durableMedia?.media,
    transcriptions: durableMedia?.transcriptions
  });
  await app.register(supervisionRoutes, { evolution: evolutionRuntime });
  if (inboxTriage) await app.register(inboxTriageRoutes, { triage: inboxTriage });
  if (followupService && followupOutbound) {
    await app.register(conversationFollowupsRoutes, {
      followups: followupService,
      outbound: followupOutbound,
      publisher: followupPublisher
    });
  }
  await app.register(quickRepliesRoutes);
  await app.register(uploadsRoutes, {
    publicTalkUrl: env.PUBLIC_TALK_URL,
    uploadDir: env.TALK_UPLOAD_DIR
  });
  await app.register(contactsRoutes, { evolution: evolutionRuntime });
  await app.register(boardsRoutes);
  await app.register(channelsRoutes, { evolution: evolutionRuntime, waha: wahaRuntime, channelHealth: channelWatchdog });
  if (outboundJournal) await app.register(outboundReviewRoutes, { journal: outboundJournal });
  if (options.prismaEnabled !== false) await app.register(historyComparisonRoutes, { db: app.prisma, deps: { evolution: evolutionHistorySource ?? null, waha: wahaRuntime.client, wahaLids: wahaRuntime.client ? createWahaLidResolver(wahaRuntime.client) : null } });
  if (options.prismaEnabled !== false) await app.register(conversationAuthorityRoutes, { db: app.prisma, async onResolved(workspaceId, conversationIds) {
    for (const conversationId of conversationIds) {
      const conversation = await createConversationsService(app.prisma as unknown as ConversationsPrismaLike).getConversationDto({ workspaceId, conversationId });
      app.realtime.publish({ type: "conversation.updated", workspaceId, payload: conversation });
    }
  } });
  // Redundancy health: 15 s probes of both connections, receive-loss detection and writer failover/return.
  if (options.prismaEnabled !== false && env.CHANNEL_HEALTH_MONITOR_ENABLED && wahaRuntime.enabled) {
    const connections = createChannelConnectionsService(app.prisma, { waha: wahaRuntime, evolution: evolutionRuntime });
    const healthMonitor = createChannelHealthMonitor({
      db: app.prisma,
      probe: (scope) => connections.refresh(scope),
      onWriterChange: async (change) => {
        const channel = await app.prisma.channel.findFirst({ where: { workspaceId: change.workspaceId, id: change.channelId } });
        if (channel) app.realtime.publish({ type: 'channel.updated', workspaceId: change.workspaceId, payload: await connections.describe(channel) });
      },
      onStatusChange: async (change) => {
        const channel = await app.prisma.channel.findFirst({ where: { workspaceId: change.workspaceId, id: change.channelId } });
        if (channel) app.realtime.publish({ type: 'channel.updated', workspaceId: change.workspaceId, payload: await connections.describe(channel) });
      },
      logger: app.log
    });
    healthMonitor.start();
    app.addHook('onClose', async () => { healthMonitor.stop(); });
  }
  await app.register(automationsRoutes, { agentRuntime, evolution: evolutionRuntime });
  await app.register(campaignsRoutes, { evolution: evolutionRuntime });
  await app.register(broadcastListsRoutes);
  if (options.prismaEnabled !== false && evolutionRuntime.mode === "real" &&
      evolutionRuntime.client?.checkWhatsappNumbersAvailability) {
    const campaignWorker = createCampaignWorker({ prisma: app.prisma,
      evolution: evolutionRuntime.client,
      onProspectingReplyReady: async (reply) => { await agentRuntime?.prepareAudioMessage({ workspaceId: reply.workspaceId, messageId: reply.messageId }); await agentReplyScheduler?.scheduleActiveSessionForMessage(reply); },
      onConversationUpdated: async ({ workspaceId, conversationId }) => {
        const payload = await createConversationsService(app.prisma as unknown as ConversationsPrismaLike)
          .getConversationDto({ workspaceId, conversationId });
        app.realtime.publish({ type: 'conversation.updated', workspaceId, payload });
      },
      onError: (error) => app.log.error({ err: error }, "Campaign worker failed; queue remains persisted.") });
    campaignWorker.start();
    app.addHook("onClose", async () => { await campaignWorker.stop(); });
  }
  await app.register(reportsRoutes);
  await app.register(teamRoutes);
  await app.register(tagsRoutes);
  await app.register(agentPackageRoutes);
  await app.register(agentsRoutes, {
    publicTalkUrl: env.PUBLIC_TALK_URL,
    uploadDir: env.TALK_UPLOAD_DIR,
    agentImprovements
  });
  await app.register(assistantRoutes);
  await app.register(assistantInboxRoutes, { scheduler: assistantScheduler, handoffBriefService, evolution: evolutionRuntime });
  await app.register(crmRoutes, {
    vinculaApiUrl: env.VINCULA_CRM_API_URL
  });
  await app.register(settingsRoutes, { handoffBriefService });

  return app;
}
