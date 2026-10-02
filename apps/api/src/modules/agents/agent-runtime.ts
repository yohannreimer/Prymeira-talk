import { markProspectingFollowupObserved } from "../prospecting/prospecting-followup-observation.js";
import { ownsAgentReplyClaim, type AgentReplyClaim } from "./agent-reply-claim.js";
import { observeProspectingAudioRefusal, isLiveProspectingAudio } from "../prospecting/prospecting-lifecycle.js";
import { isExplicitProspectingRefusal } from "../prospecting/prospecting-refusal.js";
import { reserveProspectingOutbound, dispatchProspectingOutbound } from "../prospecting/prospecting-delivery.js";
import { buildProspectingInstructions } from "../prospecting/prospecting-instructions.js";
import { autonomousAgentAllowed, findProspectingReservation, asRecord, stopProspectingConversation } from "../prospecting/prospecting-policy.js";
import { aiAgentAllowedActionSchema, type AiAgentAllowedAction, type MessageDto } from "@prymeira-talk/shared";
import { createHash } from "node:crypto";
import { usesContextFirst, resolveConversationSafetyOutput, conversationReasoningContext } from "./conversation-reasoning-policy.js";
import {
  resolveOpenAiCompatibleSettings,
  type AiProviderSettingsPrismaLike,
  type OpenAiCompatibleSettings
} from "./ai-provider-settings.js";
import {
  executeAgentActions,
  type AgentToolExecutionResult,
  type AgentToolExecutorPrismaLike
} from "./agent-tool-executor.js";
import {
  buildConversationContext,
  type ConversationContext,
  type ConversationContextBuilderPrismaLike
} from "./conversation-context-builder.js";
import { buildAgentDecisionContext } from "./agent-decision-context.js";
import {
  isDocumentDependentQuestion,
  selectRelevantKnowledge,
  type KnowledgeRetrievalSource,
  type SelectedKnowledgeSource
} from "./knowledge-retrieval.js";
import { enforceWhatsAppReply } from "./agent-reply-policy.js";
import { normalizeAgentHandoffOutput, usesQualificationHandoff } from "./agent-output-normalizer.js";
import {
  evaluateAgentSafety,
  HANDOFF_ACKNOWLEDGEMENT
} from "./agent-safety-policy.js";
import { readKnowledgeTaxonomy } from "./knowledge-taxonomy.js";
import { visibleConversationMessageWhere } from "../conversations/internal-message.js";
import {
  createOpenAiCompatibleAgentProvider,
  readAgentReasoningEffort,
  type AgentOutput,
  type AgentProvider
} from "./provider-gateway.js";
import { AgentMediaError, resolveAgentMedia } from "./agent-media-resolver.js";
import { durableMediaResolverFor } from "./durable-media-resolver.js";
import type { MessageMediaService } from "../conversations/message-media.js";
import type { MessageTranscriptionService } from "../conversations/message-transcription.js";
import { prepareInboundMedia, formatProcessedMediaMessage, transcribeInboundAudio, MAX_INBOUND_MEDIA_BYTES, type InboundMediaResult } from "./inbound-media.js";
import type { AgentAudioTranscriber } from "./audio-transcription.js";
import { toConversationDto, toMessageDto } from "../conversations/conversations.service.js";
import type { EvolutionRuntime } from "../evolution/evolution-runtime.js";
import { evaluateAgentLoopGuard } from "./agent-loop-guard.js";
import type { AgentReplyPreflight, AgentReplyPreflightResult } from "./jev-reply-preflight.js";
import type { ConversationFollowupsObserver } from "../followups/conversation-followups.service.js";
import type { InboxTriageObserver } from "../conversations/inbox-triage.service.js";

import { blocksAutonomousAgent } from '../assistant/assistant-policy.js';
type JsonValue = unknown;
type AgentRunStatus = "completed" | "handoff_requested" | "failed" | "skipped";
type AgentRunTrigger = "automation" | "manual_test";

type AiAgentRecord = {
  id: string;
  workspaceId: string;
  status?: string;
  type?: string;
  model: string;
  systemPrompt: string;
  behaviorConfig: JsonValue;
  handoffConfig: JsonValue;
  allowedActions: JsonValue;
  allowedTags?: Array<{
    tag?: {
      id: string;
      name: string;
      color: string | null;
      useGuide: string | null;
      isActive: boolean;
    } | null;
  }>;
};

type AllowedAgentTag = {
  id: string;
  name: string;
  color: string | null;
  useGuide: string | null;
};

type ConversationRecord = {
  id: string;
  workspaceId: string;
  contactId: string;
  channelId?: string | null;
  aiControlStatus: string;
  activeAgentSessionId?: string | null;
  contact?: {
    id?: string;
    name?: string | null;
    phone?: string | null;
    isGroup?: boolean;
    email?: string | null;
    company?: string | null;
  } | null;
  channel?: {
    encryptedConfig?: unknown;
    id?: string;
    provider?: string | null;
    providerKey?: string | null;
  } | null;
  tags?: Array<{ tag?: { id?: string; name?: string | null; color?: string | null } | null }>;
};

type MessageRecord = {
  id: string;
  workspaceId: string;
  conversationId: string;
  providerMessageId?: string | null;
  direction: MessageDto["direction"];
  type: MessageDto["type"];
  body: string | null;
  mediaUrl?: string | null;
  metadata?: JsonValue;
  status: MessageDto["status"];
  sentByUserId?: string | null;
  createdAt: Date | string;
};

type KnowledgeSourceRecord = {
  id: string;
  title: string;
  content: string | null;
  fileUrl?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  metadata?: JsonValue;
};

type ApprovedAttachment = {
  title: string;
  url: string;
  fileName: string | null;
  mimeType: string | null;
};

type PendingAttachment = {
  url: string;
  caption: string | null;
  fileName: string | null;
  mimeType: string | null;
};

type AgentRuntimeChatHistory = {
  hasPriorMessages(input: {
    instanceName: string;
    remoteJid: string;
    excludeMessageId?: string | null;
    before?: Date;
  }): Promise<boolean>;
};

type AgentSessionRecord = {
  id: string;
  workspaceId: string;
  agentId: string;
  conversationId: string;
};

type AgentRuntimePrismaLike = Omit<
  AgentToolExecutorPrismaLike,
  "conversation" | "aiAgentSession"
> & {
  aiAgent: {
    findFirst(args: unknown): Promise<AiAgentRecord | null>;
  };
  integrationConfig: AiProviderSettingsPrismaLike["integrationConfig"];
  aiKnowledgeSource: {
    findMany(args: unknown): Promise<KnowledgeSourceRecord[]>;
  };
  aiAgentSession: AgentToolExecutorPrismaLike["aiAgentSession"] & {
    upsert(args: unknown): Promise<AgentSessionRecord>;
  };
  conversation: {
    findUnique(args: unknown): Promise<ConversationRecord | null>;
    update(args: unknown): Promise<unknown>;
  };
  message: {
    findFirst(args: unknown): Promise<MessageRecord | null>;
    findMany: ConversationContextBuilderPrismaLike["message"]["findMany"];
    update(args: unknown): Promise<MessageRecord>;
    create(args: unknown): Promise<MessageRecord>;
    count(args: unknown): Promise<number>;
  };
  aiAgentRun: {
    create(args: unknown): Promise<{ id: string; status: AgentRunStatus }>;
  };
  auditLog: {
    create(args: unknown): Promise<unknown>;
  };
};

export type AgentRuntimeResult = {
  status: AgentRunStatus;
  runId?: string;
  sessionId?: string;
  message?: string;
};

type AgentRuntimeEvolution = {
  mode: EvolutionRuntime["mode"];
  client?:
    | (Pick<NonNullable<EvolutionRuntime["client"]>, "sendText"> &
        Partial<Pick<NonNullable<EvolutionRuntime["client"]>, "sendMedia">>)
    | null;
};

type AgentRuntimeRealtime = {
  publish(event: unknown): void;
};

type AgentRuntimeBoardRules = {
  applyBoardRulesForConversationTags(input: {
    workspaceId: string;
    conversationId: string;
    publish?: (event: unknown) => void;
  }): Promise<unknown>;
};

export const IMAGE_PROCESSING_FALLBACK =
  "Não foi possível ler automaticamente esta imagem. Atendimento humano necessário.";
export const AUDIO_PROCESSING_FALLBACK =
  "Não consegui entender esse áudio. Pode reenviar ou escrever a mensagem?";
export const AUDIO_TRANSCRIPTION_DISPLAY_FALLBACK =
  "Não foi possível transcrever este áudio.";

const AUDIO_MEDIA_POLICY = {
  kind: "audio" as const,
  maxBytes: MAX_INBOUND_MEDIA_BYTES,
  allowedMimeTypes: new Set([
    "audio/ogg", "audio/opus", "audio/webm", "video/webm", "audio/mpeg",
    "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/wav", "audio/x-wav"
  ])
};

const agentInclude = {
  allowedTags: {
    include: { tag: true },
    orderBy: { tag: { name: "asc" } }
  }
} as const;

export function createAgentRuntime(input: {
  prisma: AgentRuntimePrismaLike;
  provider: AgentProvider;
  providerFactory?: (settings: Extract<OpenAiCompatibleSettings, { active: true }>) => AgentProvider;
  mediaResolver?: typeof resolveAgentMedia;
  mediaPreparer?: typeof prepareInboundMedia;
  /** Durable media copies and the shared transcription job; both optional, legacy behaviour without them. */
  durableMedia?: Pick<MessageMediaService, "read">;
  transcriptions?: MessageTranscriptionService;
  replyPreflight?: AgentReplyPreflight;
  audioTranscriberFactory?: (
    settings: Extract<OpenAiCompatibleSettings, { active: true }>
  ) => AgentAudioTranscriber;
  evolution?: AgentRuntimeEvolution;
  chatHistory?: AgentRuntimeChatHistory;
  realtime?: AgentRuntimeRealtime;
  boardRules?: AgentRuntimeBoardRules;
  followupService?: ConversationFollowupsObserver;
  inboxTriage?: InboxTriageObserver;
  handoffBriefService?: { schedule(input: { workspaceId: string; conversationId: string }): void };
  logger?: { warn(fields: Record<string, unknown>, message: string): void };
}) {
  const { prisma, provider } = input;

  async function observeAgentOutboundFollowup(
    outboundMessage: Pick<MessageRecord, "id" | "workspaceId" | "conversationId" | "status">
  ) {
    if (outboundMessage.status !== "pending") {
      await input.inboxTriage?.observeMessage({
        workspaceId: outboundMessage.workspaceId,
        conversationId: outboundMessage.conversationId,
        messageId: outboundMessage.id, direction: "outbound", observedAt: new Date()
      }).catch((error: unknown) => {
        input.logger?.warn({ err: error, conversationId: outboundMessage.conversationId }, "Inbox triage observation failed");
      });
    }
    await input.followupService?.observeConversationActivity({
      workspaceId: outboundMessage.workspaceId,
      conversationId: outboundMessage.conversationId,
      messageId: outboundMessage.id,
      direction: "outbound",
      source: "agent"
    }).then(() => markProspectingFollowupObserved(prisma, outboundMessage.id)).catch((error: unknown) => {
      console.error("Failed to observe agent outbound follow-up.", error);
    });
  }

  async function prepareAudioMessageRecord(
    message: MessageRecord,
    resolvedProviderSettings?: OpenAiCompatibleSettings
  ) {
    if (message.type !== "audio") {
      return { status: "skipped" as const };
    }
    if (message.body === AUDIO_TRANSCRIPTION_DISPLAY_FALLBACK) {
      return { status: "failed" as const, errorCode: "TRANSCRIPTION_FAILED" };
    }
    if (!isPendingAudioBody(message.body)) {
      await observeProspectingAudioRefusal(prisma, message, message.body ?? "");
      return { status: "completed" as const, text: message.body ?? "" };
    }

    // Bytes for the transcriber: the durable original when the deployment keeps one (provider-independent,
    // 25 MiB stored, 8 MiB processed), otherwise the legacy message URL.
    const loadAudio = async () => {
      if (input.durableMedia) {
        const stored = await input.durableMedia
          .read({ workspaceId: message.workspaceId, conversationId: message.conversationId, messageId: message.id, variant: "original" })
          .catch(() => null);
        if (stored) {
          if (stored.bytes.length > MAX_INBOUND_MEDIA_BYTES) throw new AgentMediaError("MEDIA_TOO_LARGE", "Inbound media exceeds the size limit.");
          if (!AUDIO_MEDIA_POLICY.allowedMimeTypes.has(stored.mimeType)) throw new AgentMediaError("UNSUPPORTED_MEDIA_TYPE", "Inbound media type is unsupported.");
          return { bytes: stored.bytes, mimeType: stored.mimeType, source: "durable" as const };
        }
      }
      return (input.mediaResolver ?? resolveAgentMedia)({ mediaUrl: message.mediaUrl, policy: AUDIO_MEDIA_POLICY });
    };
    const transcribe = async () => {
      const providerSettings = resolvedProviderSettings ??
        await resolveOpenAiCompatibleSettings(prisma, {
          workspaceId: message.workspaceId
        });
      if (!providerSettings.active) {
        throw Object.assign(new Error("Audio provider is unavailable."), {
          code: "TRANSCRIPTION_PROVIDER_UNAVAILABLE"
        });
      }
      const media = await loadAudio();
      const transcription = await transcribeInboundAudio({
        bytes: media.bytes,
        mimeType: media.mimeType,
        settings: providerSettings,
        audioTranscriberFactory: input.audioTranscriberFactory
      });
      return { media, transcription };
    };

    if (input.transcriptions) {
      // One persistent job per message, shared with the manual button: the first caller transcribes,
      // the others reuse the text instead of paying for a second transcription.
      const worked: { value?: Awaited<ReturnType<typeof transcribe>> } = {};
      const outcome = await input.transcriptions.run({
        workspaceId: message.workspaceId,
        conversationId: message.conversationId,
        messageId: message.id,
        retryFailed: false,
        failureBody: AUDIO_TRANSCRIPTION_DISPLAY_FALLBACK,
        work: async () => {
          worked.value = await transcribe();
          const { media, transcription } = worked.value;
          return {
            text: transcription.text,
            // With a durable copy the playback derivative lives in the store, not inline in the message.
            ...(transcription.playback && media.source !== "durable"
              ? { extraMessageData: { mediaUrl: toAudioDataUrl(transcription.playback) } }
              : {})
          };
        }
      });
      if ("message" in outcome && outcome.message) {
        input.realtime?.publish({ type: "message.created", workspaceId: message.workspaceId, payload: toMessageDto(outcome.message) });
      }
      if (outcome.status === "completed") {
        await observeProspectingAudioRefusal(prisma, message, outcome.text);
        return {
          status: "completed" as const,
          text: outcome.text,
          ...(worked.value
            ? { media: { type: "audio" as const, mimeType: worked.value.media.mimeType, source: worked.value.media.source } }
            : {})
        };
      }
      return {
        status: "failed" as const,
        errorCode: outcome.status === "failed" ? outcome.errorCode : "TRANSCRIPTION_IN_PROGRESS"
      };
    }

    try {
      const { media, transcription } = await transcribe();
      const updatedAudioMessage = await prisma.message.update({
        where: { id: message.id },
        data: {
          body: transcription.text,
          ...(transcription.playback
            ? { mediaUrl: toAudioDataUrl(transcription.playback) }
            : {})
        }
      });
      await observeProspectingAudioRefusal(prisma, message, transcription.text);
      input.realtime?.publish({
        type: "message.created",
        workspaceId: message.workspaceId,
        payload: toMessageDto(updatedAudioMessage)
      });
      return {
        status: "completed" as const,
        text: transcription.text,
        media: {
          type: "audio" as const,
          mimeType: media.mimeType,
          source: media.source
        }
      };
    } catch (error) {
      const errorCode = readStableMediaErrorCode(error);
      const failedAudioMessage = await prisma.message.update({
        where: { id: message.id },
        data: { body: AUDIO_TRANSCRIPTION_DISPLAY_FALLBACK }
      });
      input.realtime?.publish({
        type: "message.created",
        workspaceId: message.workspaceId,
        payload: toMessageDto(failedAudioMessage)
      });
      return { status: "failed" as const, errorCode };
    }
  }

  return {
    async prepareAudioMessage(prepareInput: { workspaceId: string; messageId: string }) {
      const message = await prisma.message.findFirst({
        where: {
          workspaceId: prepareInput.workspaceId,
          id: prepareInput.messageId
        }
      });
      if (message && await findProspectingReservation(prisma, prepareInput.workspaceId, message.conversationId) && !await isLiveProspectingAudio(prisma, message)) return { status: "skipped" as const };
      return message
        ? prepareAudioMessageRecord(message)
        : { status: "skipped" as const };
    },

    async activateForMessage(runInput: {
      workspaceId: string;
      agentId: string;
      conversationId: string;
      messageId: string;
      instruction?: string | null;
    }): Promise<AgentRuntimeResult> {
      const [activeAgent, conversation, message] = await Promise.all([
        prisma.aiAgent.findFirst({
          where: {
            workspaceId: runInput.workspaceId,
            id: runInput.agentId,
            status: "active"
          },
          include: agentInclude
        }),
        prisma.conversation.findUnique({
          where: {
            workspaceId_id: {
              workspaceId: runInput.workspaceId,
            id: runInput.conversationId
            }
          },
          include: { channel: true, contact: true }
        }),
        prisma.message.findFirst({
          where: {
            workspaceId: runInput.workspaceId,
            id: runInput.messageId
          }
        })
      ]);

      if (!activeAgent) {
        const inactiveAgent = await prisma.aiAgent.findFirst({
          where: {
            workspaceId: runInput.workspaceId,
            id: runInput.agentId
          }
        });

        return {
          status: "failed",
          message: inactiveAgent
            ? "O agente selecionado está inativo. Ative o agente antes de usar em automações."
            : "Agent was not found."
        };
      }

      if (!conversation || !message || message.conversationId !== conversation.id) {
        return { status: "failed", message: "Conversation or message was not found." };
      }

      if (conversation.contact?.isGroup || conversation.contact?.phone?.endsWith('@g.us') || conversation.aiControlStatus === "human_controlled" || blocksAutonomousAgent(conversation.channel?.encryptedConfig)) {
        return { status: "skipped", message: conversation.aiControlStatus === "human_controlled"
          ? "Conversation is controlled by a human."
          : conversation.contact?.isGroup || conversation.contact?.phone?.endsWith('@g.us')
            ? "Autonomous replies are disabled for WhatsApp groups."
            : "Channel is configured for private suggestions without autonomous sending." };
      }

      if (activeAgent.type === "prospecting" || await findProspectingReservation(prisma, runInput.workspaceId, conversation.id)) return { status: "skipped", message: "Campaign conversation is reserved for prospecting." };

      if (readOnlyNewConversations(activeAgent.behaviorConfig) && !conversation.activeAgentSessionId) {
        const freshness = await evaluateFreshConversation({
          prisma,
          chatHistory: input.chatHistory,
          workspaceId: runInput.workspaceId,
          conversation,
          message
        });

        if (!freshness.ok) {
          await prisma.conversation.update({
            where: {
              workspaceId_id: {
                workspaceId: runInput.workspaceId,
                id: conversation.id
              }
            },
            data: {
              aiControlStatus: "human_controlled",
              activeAgentSessionId: null
            }
          });
          if (message.direction === "inbound") {
            await input.inboxTriage?.observeMessage({
              workspaceId: runInput.workspaceId,
              conversationId: conversation.id,
              messageId: message.id,
              direction: "inbound",
              observedAt: new Date()
            }).catch((error: unknown) => {
              input.logger?.warn({ err: error, conversationId: conversation.id }, "Inbox triage observation failed");
            });
          }
          await publishConversationUpdated(runInput.workspaceId, conversation.id);

          return { status: "skipped", message: freshness.reason };
        }
      }

      const metadata = runInput.instruction?.trim()
        ? { instruction: runInput.instruction.trim() }
        : {};
      const session = await prisma.aiAgentSession.upsert({
        where: {
          workspaceId_agentId_conversationId: {
            workspaceId: runInput.workspaceId,
            agentId: activeAgent.id,
            conversationId: conversation.id
          }
        },
        create: {
          workspaceId: runInput.workspaceId,
          agentId: activeAgent.id,
          conversationId: conversation.id,
          status: "active",
          metadata
        },
        update: {
          status: "active",
          metadata
        }
      });

      await prisma.conversation.update({
        where: {
          workspaceId_id: {
            workspaceId: runInput.workspaceId,
            id: conversation.id
          }
        },
        data: {
          activeAgentSessionId: session.id,
          aiControlStatus: "agent_allowed"
        }
      });

      return {
        status: "completed",
        sessionId: session.id,
        message: "Agent session activated."
      };
    },

    async runForMessage(runInput: {
      workspaceId: string;
      agentId: string;
      conversationId: string;
      messageId: string;
      trigger: AgentRunTrigger;
      instruction?: string | null;
      prospectingGeneration?: string | null;
      replyClaim?: AgentReplyClaim;
    }): Promise<AgentRuntimeResult> {
      if (!await ownsAgentReplyClaim(prisma, runInput.workspaceId, runInput.replyClaim)) return { status: "skipped", message: "Agent reply queue ownership changed." };
      const [activeAgent, conversation, message] = await Promise.all([
        prisma.aiAgent.findFirst({
          where: {
            workspaceId: runInput.workspaceId,
            id: runInput.agentId,
            status: "active"
          },
          include: agentInclude
        }),
        prisma.conversation.findUnique({
          where: {
            workspaceId_id: {
              workspaceId: runInput.workspaceId,
              id: runInput.conversationId
            }
          },
          include: {
            contact: true,
            channel: true,
            tags: { include: { tag: true } }
          }
        }),
        prisma.message.findFirst({
          where: {
            workspaceId: runInput.workspaceId,
            id: runInput.messageId
          }
        })
      ]);

      const agent =
        activeAgent ??
        (await prisma.aiAgent.findFirst({
          where: {
            workspaceId: runInput.workspaceId,
            id: runInput.agentId
          }
        }));

      if (!agent) {
        return { status: "failed", message: "Agent was not found." };
      }

      if (!activeAgent || !conversation || !message) {
        const errorMessage = activeAgent
          ? "Conversation or message was not found."
          : agent.status === "inactive"
            ? "O agente selecionado está inativo. Ative o agente antes de usar em automações."
            : "Agent, conversation, or message was not found.";
        const run = await createRun({
          workspaceId: runInput.workspaceId,
          agentId: agent.id,
          conversationId: conversation?.id ?? null,
          trigger: runInput.trigger,
          input: runInput,
          model: agent.model,
          status: "failed",
          errorMessage
        });
        return { status: "failed", runId: run.id, message: errorMessage };
      }

      if (message.conversationId !== conversation.id) {
        const run = await createRun({
          workspaceId: runInput.workspaceId,
          agentId: agent.id,
          conversationId: conversation.id,
          trigger: runInput.trigger,
          input: runInput,
          model: agent.model,
          status: "failed",
          errorMessage: "Message does not belong to the conversation."
        });
        return { status: "failed", runId: run.id, message: "Message does not belong to the conversation." };
      }

      const prospecting = await findProspectingReservation(prisma, runInput.workspaceId, conversation.id);
      const prospectingGeneration = prospecting?.generation;
      if (conversation.contact?.isGroup || conversation.contact?.phone?.endsWith('@g.us') || !await autonomousAgentAllowed(prisma, {
        workspaceId: runInput.workspaceId, conversationId: conversation.id, agentId: agent.id,
        expectedGeneration: runInput.prospectingGeneration ?? prospectingGeneration, channelConfig: conversation.channel?.encryptedConfig, aiControlStatus: conversation.aiControlStatus
      })) {
        const errorMessage = conversation.aiControlStatus === "human_controlled"
          ? "Conversation is controlled by a human."
          : conversation.contact?.isGroup || conversation.contact?.phone?.endsWith('@g.us')
            ? "Autonomous replies are disabled for WhatsApp groups."
            : "Channel is configured for private suggestions without autonomous sending.";
        const run = await createRun({
          workspaceId: runInput.workspaceId,
          agentId: agent.id,
          conversationId: conversation.id,
          trigger: runInput.trigger,
          input: runInput,
          model: agent.model,
          status: "skipped",
          errorMessage
        });
        return { status: "skipped", runId: run.id, message: errorMessage };
      }

      const campaignContext = prospecting ? await (prisma as unknown as import("@prisma/client").PrismaClient).campaign.findFirst({ where: { workspaceId: runInput.workspaceId, id: prospecting.campaignId } }) : null;
      const effectiveSystemPrompt = prospecting ? buildProspectingInstructions(agent.systemPrompt, asRecord(agent.handoffConfig).prospectingGoal, campaignContext?.prospectingContext) : agent.systemPrompt;

      const runInputPayload = {
        workspaceId: runInput.workspaceId,
        agentId: agent.id,
        conversationId: conversation.id,
        messageId: message.id,
        trigger: runInput.trigger,
        instruction: runInput.instruction ?? null
      };
      let contextSummary: Record<string, unknown> = {
        contactId: conversation.contactId,
        contactName: conversation.contact?.name ?? null,
        channelId: conversation.channelId ?? conversation.channel?.id ?? null,
        tagCount:
          conversation.tags?.filter((item) => Boolean(item.tag?.name)).length ?? 0,
        knowledgeCount: 0
      };
      let knowledgeMatches: Array<Record<string, unknown>> = [];
      let providerOutput: AgentOutput | undefined;
      let runModel = agent.model;
      let actionResults: Awaited<ReturnType<typeof executeAgentActions>> = [];

      const session = await prisma.aiAgentSession.upsert({
        where: {
          workspaceId_agentId_conversationId: {
            workspaceId: runInput.workspaceId,
            agentId: agent.id,
            conversationId: conversation.id
          }
        },
        create: {
          workspaceId: runInput.workspaceId,
          agentId: agent.id,
          conversationId: conversation.id,
          status: "active",
          metadata: {}
        },
        update: prospecting ? {} : {
          status: "active"
        }
      });

      try {
        if (conversation.activeAgentSessionId !== session.id) {
          await prisma.conversation.update({
            where: {
              workspaceId_id: {
                workspaceId: runInput.workspaceId,
                id: conversation.id
              }
            },
            data: {
              activeAgentSessionId: session.id
            }
          });
          conversation.activeAgentSessionId = session.id;
        }

        const recentMessages = await prisma.message.findMany({
          where: visibleConversationMessageWhere({
            workspaceId: runInput.workspaceId,
            conversationId: conversation.id,
            createdAt: { gte: new Date(Date.now() - 2 * 60 * 1_000) }
          }),
          orderBy: [{ createdAt: "desc" }],
          take: 30
        }) as MessageRecord[];
        const loopGuard = evaluateAgentLoopGuard({
          messages: recentMessages,
          now: new Date()
        });

        if (loopGuard.triggered) {
          const loopContextSummary = {
            ...contextSummary,
            loopGuard: loopGuard.guard,
            loopInboundCount: loopGuard.inboundCount,
            loopAiOutboundCount: loopGuard.aiOutboundCount
          };
          await prisma.aiAgentSession.update({
            where: {
              workspaceId_id: {
                workspaceId: runInput.workspaceId,
                id: session.id
              }
            },
            data: {
              status: "handoff_requested",
              handoffReason: "possible_automation_loop",
              handoffActionCompletedAt: null,
              lastRunAt: new Date()
            }
          });
          await prisma.conversation.update({
            where: {
              workspaceId_id: {
                workspaceId: runInput.workspaceId,
                id: conversation.id
              }
            },
            data: {
              aiControlStatus: "human_controlled"
            }
          });
          await prisma.auditLog.create({
            data: {
              workspaceId: runInput.workspaceId,
              actorUserId: null,
              action: "agent.automation_loop_stopped",
              targetType: "conversation",
              targetId: conversation.id,
              metadata: {
                guard: loopGuard.guard,
                inboundCount: loopGuard.inboundCount,
                aiOutboundCount: loopGuard.aiOutboundCount
              }
            }
          });
          if (prospecting) await stopProspectingConversation(prisma, runInput.workspaceId, conversation.id, "possible_automation_loop");
          await publishConversationUpdated(runInput.workspaceId, conversation.id);
          const run = await createRun({
            workspaceId: runInput.workspaceId,
            agentId: agent.id,
            sessionId: session.id,
            conversationId: conversation.id,
            trigger: runInput.trigger,
            input: runInputPayload,
            contextSummary: loopContextSummary,
            model: agent.model,
            status: "handoff_requested"
          });
          input.handoffBriefService?.schedule({ workspaceId: runInput.workspaceId, conversationId: conversation.id });
          return {
            status: "handoff_requested",
            runId: run.id,
            message: "possible_automation_loop"
          };
        }

        const providerSettings = await resolveOpenAiCompatibleSettings(prisma, {
          workspaceId: runInput.workspaceId
        });
        if (prospecting) {
          // A newer text anchor must not hide an opt-out in an earlier audio in
          // the same burst, including audio received while dispatch was pending.
          const liveAudio = await prisma.message.findMany({ where: { workspaceId: runInput.workspaceId,
            conversationId: conversation.id, direction: "inbound", type: "audio",
            metadata: { path: ["prospectingLiveGeneration"], equals: prospecting.generation } }, orderBy: { createdAt: "asc" } });
          for (const audio of liveAudio) await prepareAudioMessageRecord(audio as MessageRecord, providerSettings);
          if (!await autonomousAgentAllowed(prisma, { workspaceId: runInput.workspaceId, conversationId: conversation.id,
            agentId: agent.id, expectedGeneration: prospectingGeneration })) return { status: "skipped", message: "Prospecting authorization changed." };
        }

        const mediaResolverFor = durableMediaResolverFor(input.durableMedia, input.mediaResolver ?? resolveAgentMedia);
        let effectiveText = message.body ?? "";
        let mediaFallback: string | null = null;
        let mediaProcessingError: string | null = null;
        let mediaMetadata: Record<string, unknown> | null = null;
        let unreadableImageRequiresHandoff = false;

        // A debounced run may be anchored on the customer's final text message,
        // leaving earlier images in that same burst unprocessed by this agent.
        const burstMessages = await prisma.message.findMany({
          where: visibleConversationMessageWhere({ workspaceId: runInput.workspaceId, conversationId: conversation.id }),
          orderBy: [{ createdAt: "desc" }],
          take: 80
        }) as MessageRecord[];
        const currentTime = new Date(message.createdAt).getTime();
        const throughCurrent = burstMessages
          .filter((entry) => new Date(entry.createdAt).getTime() <= currentTime)
          .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
        let lastOutbound = -1;
        for (let index = throughCurrent.length - 1; index >= 0; index -= 1) {
          if (throughCurrent[index].direction === "outbound") { lastOutbound = index; break; }
        }
        const customerBurstAttachments = throughCurrent.slice(lastOutbound + 1).filter((entry) =>
          entry.id !== message.id && entry.direction === "inbound" && (entry.type === "image" || entry.type === "file")
        );
        if (customerBurstAttachments.length > 5) {
          unreadableImageRequiresHandoff = true;
          mediaProcessingError = "MEDIA_BURST_LIMIT";
        }
        for (const attachment of customerBurstAttachments.slice(0, 5)) {
          const attachmentMetadata = isRecord(attachment.metadata) ? attachment.metadata : {};
          const alreadyProcessed = isRecord(attachmentMetadata.inboundMedia) && attachmentMetadata.inboundMedia.status === "processed";
          if (alreadyProcessed) continue;
          const cache = isRecord(attachmentMetadata.assistantMedia) ? attachmentMetadata.assistantMedia : null;
          const expectedHash = createHash("sha256").update(JSON.stringify([attachment.id, attachment.type, attachment.mediaUrl ?? null])).digest("hex");
          const cachedResult = cache?.sourceHash === expectedHash && isRecord(cache.result) && cache.result.status === "processed" && typeof cache.result.extractedText === "string"
            ? cache.result as InboundMediaResult
            : null;
          const prepared = cachedResult ?? await (input.mediaPreparer ?? prepareInboundMedia)({
            mediaUrl: attachment.mediaUrl,
            kind: attachment.type === "file" ? "document" : "image",
            settings: providerSettings,
            mediaResolver: mediaResolverFor(attachment)
          });
          const handled = attachment.type === "image" && prepared.status === "failed"
            ? { ...prepared, fallback: IMAGE_PROCESSING_FALLBACK }
            : prepared;
          const updated = await prisma.message.update({
            where: { id: attachment.id },
            data: {
              body: formatProcessedMediaMessage(attachment.body ?? "", handled),
              metadata: { ...attachmentMetadata, inboundMedia: handled }
            }
          });
          input.realtime?.publish({ type: "message.created", workspaceId: attachment.workspaceId, payload: toMessageDto(updated) });
          if (prepared.status === "failed") {
            mediaProcessingError = prepared.errorCode ?? "MEDIA_EXTRACTION_FAILED";
            if (attachment.type === "image") unreadableImageRequiresHandoff = true;
            else mediaFallback = handled.fallback ?? "Pode reenviar o arquivo?";
            input.logger?.warn({ event: "agent_context_media_processing_failed", workspaceId: runInput.workspaceId,
              conversationId: conversation.id, messageId: attachment.id, errorCode: mediaProcessingError },
            "Context attachment could not be read.");
          }
        }

        if (message.type === "image" || message.type === "file") {
          const metadata = isRecord(message.metadata) ? message.metadata : {};
          const stored = isRecord(metadata.inboundMedia) ? metadata.inboundMedia : null;
          const media = stored?.status === "processed" && typeof stored.extractedText === "string"
            ? stored as InboundMediaResult
            : await (input.mediaPreparer ?? prepareInboundMedia)({
                mediaUrl: message.mediaUrl,
                kind: message.type === "file" ? "document" : "image",
                settings: providerSettings,
                mediaResolver: mediaResolverFor(message)
              });
          const handledMedia = message.type === "image" && media.status === "failed"
            ? { ...media, fallback: IMAGE_PROCESSING_FALLBACK }
            : media;
          mediaMetadata = { ...handledMedia };
          if (media.status === "failed") {
            mediaFallback = handledMedia.fallback ?? "Pode reenviar o arquivo?";
            mediaProcessingError = media.errorCode ?? "MEDIA_EXTRACTION_FAILED";
            unreadableImageRequiresHandoff = message.type === "image";
            if (unreadableImageRequiresHandoff) {
              input.logger?.warn({
                event: "agent_image_processing_failed",
                workspaceId: runInput.workspaceId,
                conversationId: conversation.id,
                messageId: message.id,
                errorCode: mediaProcessingError
              }, "Image could not be read; requesting human handoff.");
            }
          } else {
            effectiveText = stored?.status === "processed" ? effectiveText : formatProcessedMediaMessage(effectiveText, media);
          }
          if (stored?.status !== "processed") {
            const updated = await prisma.message.update({
              where: { id: message.id },
              data: { body: media.status === "processed" ? effectiveText : formatProcessedMediaMessage(effectiveText, handledMedia), metadata: { ...metadata, inboundMedia: handledMedia } }
            });
            input.realtime?.publish({ type: "message.created", workspaceId: message.workspaceId, payload: toMessageDto(updated) });
          }
        } else if (message.type === "audio") {
          const preparedAudio = await prepareAudioMessageRecord(message, providerSettings);
          if (preparedAudio.status === "failed") {
            mediaFallback = AUDIO_PROCESSING_FALLBACK;
            mediaProcessingError = preparedAudio.errorCode;
          } else if (preparedAudio.status === "completed") {
            effectiveText = preparedAudio.text;
            mediaMetadata = { ...("media" in preparedAudio ? preparedAudio.media : {}), kind: "audio", status: "processed", extractedText: preparedAudio.text };
          }
        }

        const [knowledge, conversationContext] = await Promise.all([
          prisma.aiKnowledgeSource.findMany({
            where: {
              workspaceId: runInput.workspaceId,
              agentId: agent.id,
              status: "ready"
            },
            orderBy: [{ createdAt: "desc" }]
          }),
          buildConversationContext(prisma, {
            workspaceId: runInput.workspaceId,
            conversationId: conversation.id,
            complete: usesContextFirst(agent.behaviorConfig)
          })
        ]);

        if (prospecting && isExplicitProspectingRefusal(effectiveText)) {
          await stopProspectingConversation(prisma, runInput.workspaceId, conversation.id, 'prospecting_refusal');
          await publishConversationUpdated(runInput.workspaceId, conversation.id);
          return { status: 'skipped', message: 'Prospecting ended after customer refusal.' };
        }
        const configuredActions = readAllowedActions(agent.allowedActions);
        const allowedActions = prospecting ? Array.from(new Set<AiAgentAllowedAction>([...configuredActions, "request_handoff", "create_internal_note"])) : configuredActions;
        const allowedTags = toAllowedTags(agent);
        const approvedAttachments = knowledge.flatMap(toApprovedAttachment);
        const approvedAttachmentUrls = new Set(approvedAttachments.map((attachment) => attachment.url));
        const taxonomy = readKnowledgeTaxonomy(agent.behaviorConfig);
        const decisionContext = buildAgentDecisionContext({
          messages: conversationContext.messages,
          currentMessageId: message.id,
          effectiveText
        });
        const knowledgeSelection = selectRelevantKnowledge({
          latestMessage: decisionContext.activeCustomerRequest,
          conversationHistory: decisionContext.formattedHistory,
          instruction: runInput.instruction,
          taxonomy,
          sources: knowledge.map(toRetrievalSource)
        });
        const jevKnowledge = knowledgeSelection.selected.map((source) => ({
          id: source.id,
          title: source.title,
          content: source.content
        }));
        const context = buildContext(
          conversation,
          message,
          knowledgeSelection.selected,
          approvedAttachments,
          conversationContext,
          allowedActions,
          allowedTags,
          effectiveText
        );
        contextSummary = {
          contactId: conversation.contactId,
          contactName: conversation.contact?.name ?? null,
          channelId: conversation.channelId ?? conversation.channel?.id ?? null,
          tagCount: context.tags.length,
          allowedTagCount: allowedTags.length,
          taxonomyKeys: taxonomy.map((entry) => entry.key),
          knowledgeCount: knowledgeSelection.selected.length,
          knowledgeTotal: knowledgeSelection.total,
          evaluatedKnowledgeChunks: knowledgeSelection.evaluatedChunks,
          selectedKnowledgeSources: new Set(
            knowledgeSelection.selected.map((source) => source.id)
          ).size,
          selectedKnowledgeChunks: knowledgeSelection.selected.length,
          selectedKnowledgeCharacters: knowledgeSelection.selected.reduce(
            (total, source) => total + source.content.length,
            0
          ),
          attachmentCount: approvedAttachments.length,
          conversationMessageCount: conversationContext.messages.length,
          jevConversationMessageCount: decisionContext.messages.length,
          jevAgentRulesCharacters: agent.systemPrompt.length,
          jevSelectedKnowledgeCharacters: jevKnowledge.reduce((sum, source) => sum + source.content.length, 0),
          jevStateCharacters: JSON.stringify({
            agentRules: effectiveSystemPrompt,
            currentMessage: { id: message.id, body: effectiveText, type: message.type },
            conversationMessages: decisionContext.messages.map((entry) => ({
              id: entry.id,
              label: entry.label,
              type: entry.type,
              body: entry.body,
              createdAt: entry.createdAt
            })),
            approvedKnowledge: jevKnowledge
          }).length
          ,...(mediaMetadata ? { media: mediaMetadata } : {})
          ,...(mediaProcessingError ? { mediaProcessingError } : {})
        };
        knowledgeMatches = knowledgeSelection.selected.map((source) => ({
          id: source.id,
          title: source.title,
          category: source.category,
          score: source.score,
          reasons: source.reasons,
          includedAs: source.includedAs,
          chunkIndex: source.chunkIndex,
          start: source.start,
          end: source.end
        }));

        const attachmentAvailable = mediaMetadata?.status === "processed" || conversationContext.messages.some((entry) =>
          ((entry.type === "image" || entry.type === "file") && /\[(Texto do PDF|Leitura da imagem) — conteúdo enviado pelo cliente\]/.test(entry.body ?? ""))
          || (entry.type === "audio" && Boolean(entry.body?.trim()) && !isPendingAudioBody(entry.body) && entry.body !== AUDIO_TRANSCRIPTION_DISPLAY_FALLBACK)
        );
        let safety = evaluateAgentSafety({
          message: effectiveText,
          conversationHistory: conversationContext.formattedHistory,
          // Do not declare an attachment missing if a media message is present in history.
          // Processing failures keep their existing media fallback above the safety output.
          attachmentAvailable,
          selectedKnowledge: knowledgeSelection.selected
        });
        let safetyOutput = resolveConversationSafetyOutput(safety, agent.behaviorConfig);
        const approvedNotSoldSourceIds = new Set(knowledge.flatMap((source) => {
          const metadata = isRecord(source.metadata) ? source.metadata : null;
          return metadata?.source === "approved_agent_improvement" && metadata.kind === "not_sold"
            ? [source.id]
            : [];
        }));
        const canReviewApprovedRefusal = Boolean(
          input.replyPreflight?.audit &&
          safetyOutput &&
          safety.handoffRequired &&
          (safety.protectedFact === "price" || safety.protectedFact === "stock") &&
          knowledgeSelection.selected.some((source) => approvedNotSoldSourceIds.has(source.id))
        );
        const documentRequiresHuman =
          !usesContextFirst(agent.behaviorConfig) &&
          !attachmentAvailable &&
          safety.outcome !== "await_approval" &&
          isDocumentDependentQuestion(effectiveText, taxonomy) &&
          knowledgeSelection.selected.length === 0;
        const approvedCatalogSelection =
          !safetyOutput && !documentRequiresHuman && allowedActions.includes("send_attachment")
            ? selectRequestedCatalog(effectiveText, approvedAttachments)
            : null;
        let replyPreflight: AgentReplyPreflightResult | undefined;

        if (input.replyPreflight && !mediaFallback && (!safetyOutput || canReviewApprovedRefusal) && !documentRequiresHuman) {
          try {
            replyPreflight = await input.replyPreflight.evaluate({
              agentRules: effectiveSystemPrompt,
              currentMessage: {
                id: message.id,
                body: effectiveText,
                type: message.type
              },
              conversationMessages: decisionContext.messages,
              selectedKnowledge: jevKnowledge
            });
            contextSummary = { ...contextSummary, replyPreflight };
          } catch {
            contextSummary = { ...contextSummary, replyPreflight: { outcome: "unavailable" } };
          }
        }

        let approvedRefusalBypass = false;
        if (
          canReviewApprovedRefusal &&
          replyPreflight?.outcome === "continue" &&
          replyPreflight.plan.commercialPath === "not_sold" &&
          replyPreflight.plan.nextAction === "answer_current_request"
        ) {
          approvedRefusalBypass = true;
          safety = { ...safety, outcome: "continue", handoffRequired: false, reason: null };
          safetyOutput = null;
          contextSummary = { ...contextSummary, approvedNotSoldGuardOverride: safety.protectedFact };
        }

        if (replyPreflight?.outcome === "silence" && !approvedCatalogSelection) {
          await prisma.aiAgentSession.update({
            where: {
              workspaceId_id: {
                workspaceId: runInput.workspaceId,
                id: session.id
              }
            },
            data: { lastRunAt: new Date() }
          });
          const run = await createRun({
            workspaceId: runInput.workspaceId,
            agentId: agent.id,
            sessionId: session.id,
            conversationId: conversation.id,
            trigger: runInput.trigger,
            input: runInputPayload,
            contextSummary,
            knowledgeMatches,
            model: agent.model,
            status: "skipped"
          });
          return { status: "skipped", runId: run.id, message: replyPreflight.reason };
        }

        const runProvider = providerSettings.active
          ? (input.providerFactory ?? createOpenAiCompatibleAgentProvider)(providerSettings)
          : provider;
        runModel = providerSettings.active ? providerSettings.chatModel : agent.model;

        if (unreadableImageRequiresHandoff) {
          providerOutput = createUnreadableImageHandoffOutput();
        } else if (mediaFallback) {
          providerOutput = {
            confidence: 1,
            reply: mediaFallback,
            actions: [],
            handoff: { required: false, reason: null }
          };
        } else if (safetyOutput) {
          providerOutput = safetyOutput;
        } else if (documentRequiresHuman) {
          providerOutput = createDocumentRequiredHandoffOutput();
        } else if (approvedCatalogSelection) {
          providerOutput = {
            confidence: 1,
            reply: "Claro, segue o catálogo da Villefer.",
            actions: [{
              type: "send_attachment",
              attachmentUrl: approvedCatalogSelection.url,
              caption: "Catálogo Villefer"
            }],
            handoff: { required: false, reason: null }
          };
          contextSummary = { ...contextSummary, catalogSelection: "approved_attachment" };
        } else {
          providerOutput = await runProvider.generate({
            reasoningEffort: readAgentReasoningEffort(agent.behaviorConfig),
            model: runModel,
            systemPrompt: effectiveSystemPrompt,
            userPrompt: buildUserPrompt(effectiveText, runInput.instruction),
            context: {
              ...context,
              ...conversationReasoningContext(agent.behaviorConfig, safety),
              ...(replyPreflight?.outcome === "continue"
                ? { agentPreflight: replyPreflight.plan }
                : {})
            }
          });
        }

        if (
          replyPreflight?.outcome === "continue" &&
          !approvedCatalogSelection &&
          input.replyPreflight?.audit &&
          providerOutput.reply &&
          requiresReplyQualityAudit(replyPreflight.plan)
        ) {
          try {
            const replyQualityAudit = await input.replyPreflight.audit({
              agentRules: effectiveSystemPrompt,
              currentMessage: {
                id: message.id,
                body: effectiveText,
                type: message.type
              },
              conversationMessages: decisionContext.messages,
              selectedKnowledge: jevKnowledge,
              candidateReply: providerOutput.reply,
              plan: replyPreflight.plan
            });
            contextSummary = { ...contextSummary, replyQualityAudit };

            if (replyQualityAudit.outcome === "suppress") {
              await prisma.aiAgentSession.update({
                where: {
                  workspaceId_id: {
                    workspaceId: runInput.workspaceId,
                    id: session.id
                  }
                },
                data: { lastRunAt: new Date() }
              });
              const run = await createRun({
                workspaceId: runInput.workspaceId,
                agentId: agent.id,
                sessionId: session.id,
                conversationId: conversation.id,
                trigger: runInput.trigger,
                input: runInputPayload,
                contextSummary,
                knowledgeMatches,
                model: runModel,
                output: providerOutput,
                status: "skipped"
              });
              return { status: "skipped", runId: run.id, message: replyQualityAudit.reason };
            }

            if (replyQualityAudit.outcome === "handoff") {
              providerOutput = {
                ...providerOutput,
                reply: null,
                actions: [
                  ...providerOutput.actions,
                  { type: "request_handoff", reason: replyQualityAudit.reason }
                ],
                handoff: { required: true, reason: replyQualityAudit.reason }
              };
            }
          } catch {
            contextSummary = { ...contextSummary, replyQualityAudit: { outcome: "unavailable" } };
            if (approvedRefusalBypass) {
              const reason = "A validação da recusa aprovada pelo JEV falhou. Revisão humana necessária.";
              providerOutput = {
                ...providerOutput,
                reply: null,
                actions: [...providerOutput.actions, { type: "request_handoff", reason }],
                handoff: { required: true, reason }
              };
            }
          }
        }

        const contextualHandoff = usesQualificationHandoff(agent.behaviorConfig);
        // A failed image is an internal handoff: normalization would synthesize a customer reply.
        providerOutput = unreadableImageRequiresHandoff
          ? providerOutput
          : normalizeAgentHandoffOutput(providerOutput, { preserveReply: contextualHandoff });

        const replyPolicy = providerOutput.reply
          ? enforceWhatsAppReply(providerOutput.reply)
          : null;
        if (replyPolicy) {
          providerOutput = { ...providerOutput, reply: replyPolicy.reply };
        }
        contextSummary = {
          ...contextSummary,
          protectedFact: safety.protectedFact,
          replyCharacters: providerOutput.reply?.length ?? 0,
          replyCompacted: replyPolicy?.compacted ?? false
        };

        const confidenceThreshold = readConfidenceThreshold(agent.handoffConfig);
        const handoffReason = getHandoffReason(providerOutput, confidenceThreshold);
        const status: AgentRunStatus = handoffReason ? "handoff_requested" : "completed";
        const outboundReply = unreadableImageRequiresHandoff
          ? null
          : handoffReason
            ? contextualHandoff && providerOutput.handoff.required && providerOutput.confidence >= confidenceThreshold
              ? providerOutput.reply ?? HANDOFF_ACKNOWLEDGEMENT
              : HANDOFF_ACKNOWLEDGEMENT
            : providerOutput.reply;

        const beforeActions = await prisma.conversation.findUnique({ where: { workspaceId_id: { workspaceId: runInput.workspaceId, id: conversation.id } }, include: { channel: true } });
        if (!await ownsAgentReplyClaim(prisma, runInput.workspaceId, runInput.replyClaim)) return { status: "skipped", message: "Agent reply queue ownership changed." };
        if (!beforeActions || !await autonomousAgentAllowed(prisma, { workspaceId: runInput.workspaceId, conversationId: conversation.id, agentId: agent.id, sessionId: session.id, expectedGeneration: prospectingGeneration, channelConfig: beforeActions.channel?.encryptedConfig, aiControlStatus: beforeActions.aiControlStatus })) return { status: 'skipped', message: 'Human review is required.' };
        actionResults = await executeAgentActions(prisma as AgentToolExecutorPrismaLike, {
          workspaceId: runInput.workspaceId,
          conversationId: conversation.id,
          allowedActions: prospecting ? Array.from(new Set<AiAgentAllowedAction>([...allowedActions, "request_handoff"])) : unreadableImageRequiresHandoff
            ? Array.from(new Set<AiAgentAllowedAction>([...allowedActions, "request_handoff"]))
            : allowedActions,
          allowedTags,
          actions: providerOutput.actions
        });
        contextSummary = {
          ...contextSummary,
          rejectedActionCodes: [
            ...new Set(
              actionResults.flatMap((result) =>
                result.status === "skipped" && result.code ? [result.code] : []
              )
            )
          ]
        };
        await applyBoardRulesForActionResults(runInput.workspaceId, actionResults);

        const pendingAttachments =
          !handoffReason && allowedActions.includes("send_attachment")
            ? actionResults
                .flatMap(toPendingAttachment)
                .filter((attachment) => approvedAttachmentUrls.has(attachment.url))
            : [];

        if (
          !handoffReason &&
          allowedActions.includes("send_message") &&
          !providerOutput.reply &&
          pendingAttachments.length === 0
        ) {
          throw new Error("Agent did not produce a reply.");
        }

        if (outboundReply && allowedActions.includes("send_message") && (!prospecting || !handoffReason)) {
          const beforeSend = await prisma.conversation.findUnique({ where: { workspaceId_id: { workspaceId: runInput.workspaceId, id: conversation.id } }, include: { channel: true } });
          if (!await ownsAgentReplyClaim(prisma, runInput.workspaceId, runInput.replyClaim)) return { status: "skipped", message: "Agent reply queue ownership changed." };
          if (!beforeSend || (prospecting ? !await autonomousAgentAllowed(prisma, { workspaceId: runInput.workspaceId, conversationId: conversation.id, agentId: agent.id, sessionId: session.id, expectedGeneration: prospectingGeneration }) : blocksAutonomousAgent(beforeSend.channel?.encryptedConfig) || (beforeSend.aiControlStatus === 'human_controlled' && !handoffReason))) return { status: 'skipped', message: 'Human review is required.' };
          const pending = prospecting ? await reserveProspectingOutbound(prisma, { workspaceId: runInput.workspaceId, conversationId: conversation.id,
            agentId: agent.id, generation: prospecting.generation, type: 'text', body: outboundReply,
            metadata: runInput.replyClaim ? { replyClaimId: runInput.replyClaim.id, replyClaimToken: runInput.replyClaim.token } : undefined }) : null;
          const providerSend = pending ? null : await sendAgentReplyToProvider(input.evolution, conversation, outboundReply);
          const outboundMessage = pending ? await dispatchProspectingOutbound(prisma, pending,
            () => sendAgentReplyToProvider(input.evolution, conversation, outboundReply)) : await prisma.message.create({
            data: {
              workspaceId: runInput.workspaceId,
              conversationId: conversation.id,
              direction: "outbound",
              type: "text",
              body: outboundReply,
              providerMessageId: providerSend?.providerMessageId ?? undefined,
              status: providerSend ? "sent" : "pending",
              sentByUserId: null,
              metadata: {
                source: "ai_agent",
                agentId: agent.id
              }
            }
          });
          await observeAgentOutboundFollowup(outboundMessage);
          input.realtime?.publish({
            type: "message.created",
            workspaceId: runInput.workspaceId,
            payload: toMessageDto(outboundMessage)
          });
          await prisma.conversation.update({
            where: {
              workspaceId_id: {
                workspaceId: runInput.workspaceId,
                id: conversation.id
              }
            },
            data: {
              lastMessageAt: new Date(),
              lastMessagePreview: outboundReply
            }
          });
        }

        for (const attachment of pendingAttachments) {
          if (!await ownsAgentReplyClaim(prisma, runInput.workspaceId, runInput.replyClaim)) return { status: "skipped", message: "Agent reply queue ownership changed." };
          if (prospecting && !await autonomousAgentAllowed(prisma, { workspaceId: runInput.workspaceId, conversationId: conversation.id, agentId: agent.id, sessionId: session.id, expectedGeneration: prospectingGeneration })) return { status: "skipped", message: "Prospecting authorization changed." };
          const pending = prospecting ? await reserveProspectingOutbound(prisma, { workspaceId: runInput.workspaceId, conversationId: conversation.id,
            agentId: agent.id, generation: prospecting.generation, type: attachment.mimeType?.startsWith('image/') ? 'image' : 'file',
            body: attachment.caption ?? attachment.fileName ?? '', mediaUrl: attachment.url,
            metadata: { attachment: true, ...(runInput.replyClaim ? { replyClaimId: runInput.replyClaim.id, replyClaimToken: runInput.replyClaim.token } : {}) } }) : null;
          const providerSend = pending ? null : await sendAgentAttachmentToProvider(input.evolution, conversation, attachment);
          const outboundMessage = pending ? await dispatchProspectingOutbound(prisma, pending,
            () => sendAgentAttachmentToProvider(input.evolution, conversation, attachment)) : await prisma.message.create({
            data: {
              workspaceId: runInput.workspaceId,
              conversationId: conversation.id,
              direction: "outbound",
              type: attachment.mimeType?.startsWith("image/") ? "image" : "file",
              body: attachment.caption ?? attachment.fileName ?? "",
              mediaUrl: attachment.url,
              providerMessageId: providerSend?.providerMessageId ?? undefined,
              status: providerSend ? "sent" : "pending",
              sentByUserId: null,
              metadata: {
                source: "ai_agent",
                agentId: agent.id,
                attachment: true
              }
            }
          });
          await observeAgentOutboundFollowup(outboundMessage);
          input.realtime?.publish({
            type: "message.created",
            workspaceId: runInput.workspaceId,
            payload: toMessageDto(outboundMessage)
          });
          await prisma.conversation.update({
            where: {
              workspaceId_id: {
                workspaceId: runInput.workspaceId,
                id: conversation.id
              }
            },
            data: {
              lastMessageAt: new Date(),
              lastMessagePreview:
                attachment.caption ?? attachment.fileName ?? "Anexo enviado"
            }
          });
        }

        if (prospecting && handoffReason) await stopProspectingConversation(prisma, runInput.workspaceId, conversation.id, handoffReason);
        await prisma.aiAgentSession.update({
          where: {
            workspaceId_id: {
              workspaceId: runInput.workspaceId,
              id: session.id
            }
          },
          data: {
            ...(prospecting && !handoffReason ? {} : { status: handoffReason ? "handoff_requested" as const : "active" as const }),
            handoffReason,
            handoffActionCompletedAt: null,
            lastRunAt: new Date(),
            messageCount: { increment: 1 }
          }
        });

        await publishConversationUpdated(runInput.workspaceId, conversation.id);

        const run = await createRun({
          workspaceId: runInput.workspaceId,
          agentId: agent.id,
          sessionId: session.id,
          conversationId: conversation.id,
          trigger: runInput.trigger,
          input: runInputPayload,
          contextSummary,
          knowledgeMatches,
          model: runModel,
          output: providerOutput,
          actions: actionResults,
          confidence: providerOutput.confidence,
          status
        });

        if (handoffReason) input.handoffBriefService?.schedule({ workspaceId: runInput.workspaceId, conversationId: conversation.id });
        return { status, runId: run.id };
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        const run = await createRun({
          workspaceId: runInput.workspaceId,
          agentId: agent.id,
          sessionId: session.id,
          conversationId: conversation.id,
          trigger: runInput.trigger,
          input: runInputPayload,
          contextSummary,
          knowledgeMatches,
          model: runModel,
          output: providerOutput,
          actions: actionResults,
          confidence: providerOutput?.confidence,
          status: "failed",
          errorMessage
        });

        return { status: "failed", runId: run.id, message: errorMessage };
      }
    }
  };

  async function publishConversationUpdated(workspaceId: string, conversationId: string) {
    if (!input.realtime) {
      return;
    }

    const updatedConversation = await prisma.conversation.findUnique({
      where: {
        workspaceId_id: {
          workspaceId,
          id: conversationId
        }
      },
      include: {
        prospectingOrigin: { select: { campaign: { select: { id: true, name: true } } } },
        assignedUser: { select: { displayName: true } },
        channel: { select: { displayName: true, phoneNumber: true, provider: true } },
        contact: { select: { name: true, phone: true } },
        department: { select: { name: true } },
        activeAgentSession: {
          select: {
            status: true,
            handoffReason: true,
            agent: { select: { name: true } }
          }
        },
        tags: { include: { tag: true } }
      }
    });

    if (!updatedConversation) {
      return;
    }

    input.realtime.publish({
      type: "conversation.updated",
      workspaceId,
      payload: toConversationDto(updatedConversation as Parameters<typeof toConversationDto>[0])
    });
  }

  async function applyBoardRulesForActionResults(
    workspaceId: string,
    actionResults: AgentToolExecutionResult[]
  ) {
    if (!input.boardRules) {
      return;
    }

    const conversationIds = [
      ...new Set(
        actionResults
          .filter(
            (result) =>
              result.type === "add_tag" && result.status === "completed" && result.conversationId
          )
          .map((result) => result.conversationId as string)
      )
    ];

    for (const conversationId of conversationIds) {
      await input.boardRules.applyBoardRulesForConversationTags({
        workspaceId,
        conversationId,
        publish: (event) => input.realtime?.publish(event)
      });
    }
  }

  async function createRun(input: {
    workspaceId: string;
    agentId: string;
    sessionId?: string | null;
    conversationId?: string | null;
    trigger: AgentRunTrigger;
    input: Record<string, unknown>;
    contextSummary?: Record<string, unknown>;
    knowledgeMatches?: Array<Record<string, unknown>>;
    model: string;
    output?: Record<string, unknown>;
    actions?: unknown[];
    status: AgentRunStatus;
    confidence?: number | null;
    errorMessage?: string | null;
  }) {
    return await prisma.aiAgentRun.create({
      data: {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        sessionId: input.sessionId ?? null,
        conversationId: input.conversationId ?? null,
        trigger: input.trigger,
        input: input.input,
        contextSummary: input.contextSummary ?? {},
        knowledgeMatches: input.knowledgeMatches ?? [],
        output: input.output ?? {},
        actions: input.actions ?? [],
        status: input.status,
        model: input.model,
        confidence: input.confidence ?? null,
        costEstimate: {},
        errorMessage: input.errorMessage ?? null
      }
    });
  }
}

function readAllowedActions(value: JsonValue): AiAgentAllowedAction[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const parsed = aiAgentAllowedActionSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function toAllowedTags(agent: Pick<AiAgentRecord, "allowedTags">): AllowedAgentTag[] {
  return (
    agent.allowedTags
      ?.filter((item) => item.tag?.isActive)
      .map((item) => ({
        id: item.tag!.id,
        name: item.tag!.name,
        color: item.tag!.color,
        useGuide: item.tag!.useGuide
      })) ?? []
  );
}

function readConfidenceThreshold(value: JsonValue) {
  if (!isRecord(value)) {
    return 0.55;
  }

  const threshold = value.confidenceThreshold;
  return typeof threshold === "number" && Number.isFinite(threshold) ? threshold : 0.55;
}

function readOnlyNewConversations(value: JsonValue) {
  return isRecord(value) && value.onlyNewConversations === true;
}

function requiresReplyQualityAudit(plan: {
  commercialPath: string;
  nextAction: string;
}) {
  return plan.commercialPath !== "not_applicable" || [
    "offer_catalog_or_seller",
    "state_made_to_order_conditions",
    "handoff"
  ].includes(plan.nextAction);
}

const FRESH_CONVERSATION_HANDOFF_REASON = "Conversa anterior ao WhatsApp — IA não iniciada.";
const FRESH_CONVERSATION_UNVERIFIED_REASON =
  "Não foi possível confirmar o histórico do WhatsApp — IA não iniciada.";

function buildRemoteJid(phone: string | null | undefined) {
  const digits = phone?.replace(/\D+/g, "") ?? "";
  return digits.length >= 10 ? `${digits}@s.whatsapp.net` : null;
}

async function evaluateFreshConversation(input: {
  prisma: AgentRuntimePrismaLike;
  chatHistory: AgentRuntimeChatHistory | undefined;
  workspaceId: string;
  conversation: ConversationRecord;
  message: MessageRecord;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const messageCreatedAt = input.message.createdAt instanceof Date
    ? input.message.createdAt
    : new Date(input.message.createdAt);
  if (!Number.isFinite(messageCreatedAt.getTime())) {
    return { ok: false, reason: FRESH_CONVERSATION_UNVERIFIED_REASON };
  }
  const priorMessages = await input.prisma.message.count({
    where: {
      workspaceId: input.workspaceId,
      conversationId: input.conversation.id,
      id: { not: input.message.id },
      createdAt: { lt: messageCreatedAt }
    }
  });

  if (priorMessages > 0) {
    return { ok: false, reason: FRESH_CONVERSATION_HANDOFF_REASON };
  }

  const provider = input.conversation.channel?.provider;
  const instanceName = input.conversation.channel?.providerKey;
  const remoteJid = buildRemoteJid(input.conversation.contact?.phone);

  if (provider !== "evolution" || !instanceName || !remoteJid || !input.chatHistory) {
    return { ok: true };
  }

  try {
    const hasPriorMessages = await input.chatHistory.hasPriorMessages({
      instanceName,
      remoteJid,
      excludeMessageId: input.message.providerMessageId ?? null,
      before: messageCreatedAt
    });

    return hasPriorMessages
      ? { ok: false, reason: FRESH_CONVERSATION_HANDOFF_REASON }
      : { ok: true };
  } catch {
    return { ok: false, reason: FRESH_CONVERSATION_UNVERIFIED_REASON };
  }
}

function buildUserPrompt(messageBody: string | null | undefined, instruction: string | null | undefined) {
  return [instruction?.trim(), messageBody?.trim()].filter(Boolean).join("\n\n");
}

function toAudioDataUrl(playback: { bytes: Buffer; mimeType: string }) {
  return `data:${playback.mimeType};base64,${playback.bytes.toString("base64")}`;
}

function isPendingAudioBody(body: string | null) {
  return !body || /^(Áudio recebido|Processando áudio\.\.\.)$/i.test(body.trim());
}

function buildContext(
  conversation: ConversationRecord,
  message: MessageRecord,
  knowledge: Pick<SelectedKnowledgeSource, "title" | "content" | "fileUrl">[],
  approvedAttachments: ApprovedAttachment[],
  conversationContext: ConversationContext,
  allowedActions: readonly AiAgentAllowedAction[],
  allowedTags: readonly AllowedAgentTag[],
  effectiveText: string
) {
  return {
    messageBody: effectiveText,
    conversationHistory: conversationContext.formattedHistory,
    conversationMessages: conversationContext.messages,
    allowedActions,
    allowedTags,
    message: {
      id: message.id,
      type: message.type ?? null,
      direction: message.direction ?? null,
      createdAt: message.createdAt ?? null
    },
    contact: {
      id: conversation.contact?.id ?? conversation.contactId,
      name: conversation.contact?.name ?? null,
      phone: conversation.contact?.phone ?? null,
      email: conversation.contact?.email ?? null,
      company: conversation.contact?.company ?? null
    },
    channel: {
      id: conversation.channel?.id ?? conversation.channelId ?? null,
      provider: conversation.channel?.provider ?? null,
      providerKey: conversation.channel?.providerKey ?? null
    },
    tags:
      conversation.tags
        ?.map((item) => item.tag?.name)
        .filter((name): name is string => Boolean(name)) ?? [],
    knowledge: knowledge.map((source) => ({
      title: source.title,
      content: source.content,
      ...(source.fileUrl ? { fileUrl: source.fileUrl } : {})
    })),
    attachments: approvedAttachments.map((attachment) => ({
      title: attachment.title,
      url: attachment.url,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType
    }))
  };
}

async function sendAgentReplyToProvider(
  evolution: AgentRuntimeEvolution | undefined,
  conversation: ConversationRecord,
  reply: string
) {
  const instanceName = conversation.channel?.providerKey;
  const number = conversation.contact?.phone;

  if (evolution?.mode !== "real" || !evolution.client || !instanceName || !number) {
    return null;
  }

  return await evolution.client.sendText({
    instanceName,
    number,
    text: reply
  });
}

function createDocumentRequiredHandoffOutput(): AgentOutput {
  const reason = "No relevant document found for a document-dependent question.";

  return {
    confidence: 0.2,
    reply: "Vou chamar uma pessoa do time para confirmar essa informação com segurança.",
    actions: [{ type: "request_handoff", reason }],
    handoff: {
      required: true,
      reason
    }
  };
}

function createUnreadableImageHandoffOutput(): AgentOutput {
  const reason = "Não foi possível ler automaticamente a imagem enviada pelo cliente. Verifique o anexo e responda o pedido.";

  return {
    confidence: 1,
    reply: null,
    actions: [{ type: "request_handoff", reason }],
    handoff: { required: true, reason }
  };
}

function toRetrievalSource(source: KnowledgeSourceRecord): KnowledgeRetrievalSource {
  return {
    id: source.id,
    title: source.title,
    content: source.content,
    metadata: isRecord(source.metadata) ? source.metadata : null,
    fileUrl: source.fileUrl ?? null,
    fileName: source.fileName ?? null,
    mimeType: source.mimeType ?? null
  };
}

function toApprovedAttachment(source: KnowledgeSourceRecord): ApprovedAttachment[] {
  const url = source.fileUrl?.trim();
  if (!url) {
    return [];
  }

  return [
    {
      title: source.title,
      url,
      fileName: source.fileName?.trim() || null,
      mimeType: source.mimeType?.trim() || null
    }
  ];
}

function selectRequestedCatalog(message: string, attachments: ApprovedAttachment[]) {
  const request = message.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
  if (!request || request.length > 120 || !/\bcatalogo\b/.test(request)) return null;
  if (/\b(?:nao|nem|sem|dispenso)\b.{0,30}\bcatalogo\b|\bcatalogo\b.{0,20}\b(?:nao|dispenso)\b/.test(request)) return null;
  if (/\b(?:preco|valor|estoque|prazo|frete|desconto|orcamento)\b/.test(request)) return null;
  const explicitChoice = /\b(?:pode ser|pode mandar|pode enviar|manda|mande|mandar|envia|envie|enviar|receber|quero|queria|gostaria|prefiro|sim|tem)\b.{0,45}\bcatalogo\b/.test(request) ||
    /^catalogo[.!?]*$/.test(request);
  if (!explicitChoice) return null;
  return attachments.find((attachment) =>
    /\bcatalogo\b/.test(`${attachment.title} ${attachment.fileName ?? ""}`
      .normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()) &&
    attachment.url.startsWith("https://") &&
    (attachment.mimeType === "application/pdf" || attachment.fileName?.toLowerCase().endsWith(".pdf"))
  ) ?? null;
}

function toPendingAttachment(result: AgentToolExecutionResult): PendingAttachment[] {
  if (result.type !== "send_attachment" || result.status !== "completed" || !result.attachmentUrl) {
    return [];
  }

  const fileName = result.attachmentFileName?.trim() || fileNameFromUrl(result.attachmentUrl);

  return [
    {
      url: result.attachmentUrl,
      caption: result.attachmentCaption ?? null,
      fileName,
      mimeType: result.attachmentMimeType?.trim() || guessMimeType(fileName)
    }
  ];
}

function fileNameFromUrl(url: string) {
  try {
    const pathname = new URL(url).pathname;
    const lastSegment = pathname.split("/").filter(Boolean).at(-1);
    return lastSegment ? decodeURIComponent(lastSegment) : null;
  } catch {
    return null;
  }
}

function guessMimeType(fileName: string | null) {
  const extension = fileName?.toLocaleLowerCase("pt-BR").split(".").at(-1) ?? "";
  const types: Record<string, string> = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    txt: "text/plain",
    csv: "text/csv",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    doc: "application/msword"
  };

  return types[extension] ?? "application/octet-stream";
}

async function sendAgentAttachmentToProvider(
  evolution: AgentRuntimeEvolution | undefined,
  conversation: ConversationRecord,
  attachment: PendingAttachment
) {
  const instanceName = conversation.channel?.providerKey;
  const number = conversation.contact?.phone;

  if (
    evolution?.mode !== "real" ||
    !evolution.client?.sendMedia ||
    !instanceName ||
    !number
  ) {
    return null;
  }

  return await evolution.client.sendMedia({
    instanceName,
    number,
    mediatype: attachment.mimeType?.startsWith("image/") ? "image" : "document",
    mimetype: attachment.mimeType ?? "application/octet-stream",
    media: attachment.url,
    fileName: attachment.fileName ?? "anexo",
    caption: attachment.caption ?? undefined
  });
}

function getHandoffReason(output: AgentOutput, confidenceThreshold: number) {
  const requestHandoffAction = output.actions.find((action) => action.type === "request_handoff");
  const isHandoffRequired =
    output.handoff.required || output.confidence < confidenceThreshold || Boolean(requestHandoffAction);

  if (!isHandoffRequired) {
    return null;
  }

  const actionReason =
    requestHandoffAction && typeof requestHandoffAction.reason === "string"
      ? requestHandoffAction.reason.trim()
      : "";
  const providerReason = output.handoff.reason?.trim() ?? "";

  return actionReason || providerReason || "Agent requested human handoff.";
}

function isRecord(value: JsonValue): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "AI agent runtime failed.";
}

function readStableMediaErrorCode(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]{1,80}$/.test(error.code)
  ) {
    return error.code;
  }
  return "MEDIA_PROCESSING_FAILED";
}
