import { messageLocationSchema } from './location.js';
import { z } from "zod";

export * from "./automation-flow.js";

export const userRoleSchema = z.enum(["owner", "manager", "agent"]);
export type UserRole = z.infer<typeof userRoleSchema>;

export const suiteModuleSchema = z.enum([
  "atendimento",
  "contatos",
  "canais",
  "automacoes",
  "disparos",
  "relatorios",
  "equipe",
  "ia",
  "atomic_crm",
  "ajustes"
]);
export type SuiteModule = z.infer<typeof suiteModuleSchema>;

export const integrationModeSchema = z.enum(["simulated", "real"]);
export type IntegrationMode = z.infer<typeof integrationModeSchema>;

export const channelProviderSchema = z.enum(["evolution", "meta_cloud"]);
export type ChannelProvider = z.infer<typeof channelProviderSchema>;
export const channelStatusSchema = z.enum(["disconnected", "connecting", "connected", "failed"]);
export type ChannelStatus = z.infer<typeof channelStatusSchema>;

export const connectionProviderSchema = z.enum(['evolution', 'waha']);
export type ConnectionProvider = z.infer<typeof connectionProviderSchema>;
export const connectionHealthSchema = z.enum(['unknown', 'healthy', 'degraded', 'unhealthy']);
export const channelConnectionSchema = z.object({
  id: z.string().min(1),
  channelId: z.string().min(1),
  provider: connectionProviderSchema,
  sessionName: z.string().min(1),
  status: channelStatusSchema,
  health: connectionHealthSchema,
  verifiedPhoneNumber: z.string().nullable(),
  eligible: z.boolean(),
  isActiveWriter: z.boolean(),
  lastCheckedAt: z.string().datetime().nullable(),
  lastError: z.string().nullable().optional()
});
export type ChannelConnectionDto = z.infer<typeof channelConnectionSchema>;

export const channelSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  provider: channelProviderSchema,
  providerKey: z.string().min(1),
  phoneNumber: z.string().nullable(),
  displayName: z.string().nullable(),
  status: channelStatusSchema,
  redundancyEnabled: z.boolean().optional(),
  redundancyAvailable: z.boolean().optional(),
  activeConnectionId: z.string().nullable().optional(),
  connections: channelConnectionSchema.array().optional(),
  connectedCount: z.number().int().min(0).max(2).optional(),
  connectionTotal: z.literal(2).optional(),
  archivedAt: z.string().datetime().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type ChannelDto = z.infer<typeof channelSchema>;
export const channelHealthStateSchema = z.enum(["ok", "reconnecting", "disconnected", "needs_qr", "silent"]);
export const channelHealthSchema = z.object({
  channelId: z.string().min(1),
  state: channelHealthStateSchema,
  since: z.string().datetime().nullable(),
  lastInboundAt: z.string().datetime().nullable(),
  attempts: z.number().int().min(0)
});
export type ChannelHealthDto = z.infer<typeof channelHealthSchema>;
export const channelWatchdogStatusSchema = z.object({
  enabled: z.boolean(),
  lastTickAt: z.string().datetime().nullable(),
  lastTickOk: z.boolean(),
  lastError: z.string().nullable(),
  unreachable: z.boolean()
});
export type ChannelWatchdogStatusDto = z.infer<typeof channelWatchdogStatusSchema>;

export const channelOperationResultSchema = z.object({
  mode: integrationModeSchema,
  channel: channelSchema
});
export type ChannelOperationResultDto = z.infer<typeof channelOperationResultSchema>;

export const channelQrResultSchema = channelOperationResultSchema.extend({
  connectionId: z.string().min(1).optional(),
  provider: connectionProviderSchema.optional(),
  qrCode: z.string().min(1),
  qr: z.object({
    payload: z.string().min(1),
    expiresAt: z.string().datetime(),
    issuedAt: z.string().datetime().optional()
  })
});
export type ChannelQrResultDto = z.infer<typeof channelQrResultSchema>;

export const channelTestInboundResultSchema = channelOperationResultSchema.extend({
  messageId: z.string().min(1)
});
export type ChannelTestInboundResultDto = z.infer<typeof channelTestInboundResultSchema>;

export const conversationStatusSchema = z.enum(["open", "pending", "closed"]);
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;
export const conversationPrioritySchema = z.enum(["low", "normal", "high"]);
export type ConversationPriority = z.infer<typeof conversationPrioritySchema>;

export const aiControlStatusSchema = z.enum(["agent_allowed", "human_controlled"]);
export type AiControlStatus = z.infer<typeof aiControlStatusSchema>;

export const aiAgentStatusSchema = z.enum(["active", "inactive"]);
export type AiAgentStatus = z.infer<typeof aiAgentStatusSchema>;

export const aiProviderModeSchema = z.enum(["prymeira_managed", "workspace_key"]);
export type AiProviderMode = z.infer<typeof aiProviderModeSchema>;

export const aiAgentSessionStatusSchema = z.enum(["active", "paused_by_human", "handoff_requested", "closed"]);
export type AiAgentSessionStatus = z.infer<typeof aiAgentSessionStatusSchema>;

export const aiAgentRunStatusSchema = z.enum(["completed", "handoff_requested", "failed", "skipped"]);
export type AiAgentRunStatus = z.infer<typeof aiAgentRunStatusSchema>;

export const aiAgentAllowedActionSchema = z.enum([
  "send_message",
  "send_attachment",
  "add_tag",
  "remove_tag",
  "change_priority",
  "create_internal_note",
  "assign_user",
  "assign_department",
  "request_handoff"
]);
export type AiAgentAllowedAction = z.infer<typeof aiAgentAllowedActionSchema>;

export const messageDirectionSchema = z.enum(["inbound", "outbound"]);
export type MessageDirection = z.infer<typeof messageDirectionSchema>;
export const messageTypeSchema = z.enum(["text", "image", "audio", "file", "template", "system", "internal_note"]);
export type MessageType = z.infer<typeof messageTypeSchema>;
export const messageStatusSchema = z.enum(["pending", "sent", "delivered", "read", "failed"]);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

export const contactSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().nullable(),
  phone: z.string().min(1),
  email: z.string().email().nullable(),
  company: z.string().nullable(),
  atomicCrmContactId: z.string().nullable(),
  atomicCrmLeadId: z.string().nullable(),
  /** AI-only marker: internal_personal contacts (colleagues, family, suppliers, carriers) never get a follow-up. */
  followupAudience: z.object({
    kind: z.enum(["customer", "internal_personal"]),
    source: z.enum(["ai", "manual"])
  }).nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type ContactDto = z.infer<typeof contactSchema>;

export const contactBoardChannelSummarySchema = z.object({
  id: z.string().min(1),
  displayName: z.string().nullable(),
  provider: channelProviderSchema,
  phoneNumber: z.string().nullable()
});
export type ContactBoardChannelSummaryDto = z.infer<typeof contactBoardChannelSummarySchema>;

export const contactBoardSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  isPrimaryPipeline: z.boolean().default(false),
  channels: contactBoardChannelSummarySchema.array().default([]),
  createdAt: z.string().datetime()
});
export type ContactBoardDto = z.infer<typeof contactBoardSchema>;

export const contactBoardStageTagSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  color: z.string().min(1),
  isActive: z.boolean()
});
export type ContactBoardStageTagDto = z.infer<typeof contactBoardStageTagSchema>;

export const contactBoardStageSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  boardId: z.string().min(1),
  name: z.string().min(1),
  color: z.string().min(1),
  order: z.number().int().min(0),
  tagTriggers: contactBoardStageTagSchema.array().default([])
});
export type ContactBoardStageDto = z.infer<typeof contactBoardStageSchema>;

export const contactBoardMoveSourceSchema = z.enum(["manual", "rule"]);
export type ContactBoardMoveSource = z.infer<typeof contactBoardMoveSourceSchema>;

export const contactBoardMembershipSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  contactId: z.string().min(1),
  boardId: z.string().min(1),
  stageId: z.string().min(1),
  isPrimary: z.boolean(),
  lastMovedBy: contactBoardMoveSourceSchema.default("manual"),
  lastRuleAppliedAt: z.string().datetime().nullable().default(null),
  updatedAt: z.string().datetime()
});
export type ContactBoardMembershipDto = z.infer<typeof contactBoardMembershipSchema>;

/** Who sent the conversation's latest message and how far it got: the queue card shows WhatsApp's ticks for our own. */
export const conversationLastMessageSchema = z.object({
  id: z.string().min(1),
  direction: messageDirectionSchema,
  status: messageStatusSchema,
  createdAt: z.string().datetime(),
  /** What the card icon shows next to the preview, like WhatsApp's camera/sticker/document glyphs. */
  kind: z.enum(['text', 'image', 'sticker', 'video', 'audio', 'file']).optional(),
  /** Who sent it in a group, for WhatsApp's "~Rejane: …" preview. */
  senderName: z.string().nullable().optional()
});
export type ConversationLastMessage = z.infer<typeof conversationLastMessageSchema>;
export type ConversationLastMessageKind = NonNullable<ConversationLastMessage['kind']>;
/** One rule for the server's list query and the browser's realtime patch. */
export function lastMessageKind(message: { type: string; body?: string | null; mimeType?: string | null; mediaUrl?: string | null }): ConversationLastMessageKind {
  const mime = (message.mimeType ?? /^data:([^;,]+)/i.exec(message.mediaUrl ?? '')?.[1] ?? '').toLowerCase();
  if (message.type === 'audio') return 'audio';
  if (message.type === 'image') return message.body === 'Figurinha recebida' ? 'sticker' : 'image';
  if (message.type === 'file') return mime.startsWith('video/') || message.body === 'Vídeo recebido' ? 'video' : mime.startsWith('image/') ? 'image' : 'file';
  return 'text';
}

export const conversationSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  channelId: z.string().min(1),
  contactId: z.string().min(1),
  contactName: z.string().nullable().optional(),
  contactPhone: z.string().nullable().optional(),
  isGroup: z.boolean().optional(),
  channelName: z.string().nullable().optional(),
  channelProvider: channelProviderSchema.nullable().optional(),
  customerServiceWindowExpiresAt: z.string().datetime().nullable().optional(),
  metaServiceWindowOpen: z.boolean().nullable().optional(),
  departmentName: z.string().nullable().optional(),
  assignedUserName: z.string().nullable().optional(),
  status: conversationStatusSchema,
  assignedUserId: z.string().nullable(),
  departmentId: z.string().nullable(),
  lastMessageAt: z.string().datetime().nullable(),
  lastMessagePreviewAt: z.string().datetime().nullable().optional(),
  lastMessagePreview: z.string().nullable(),
  lastMessage: conversationLastMessageSchema.nullable().optional(),
  unreadCount: z.number().int().min(0),
  hiddenUntilReply: z.boolean().optional(),
  priority: conversationPrioritySchema,
  aiControlStatus: aiControlStatusSchema.optional(),
  activeAgentName: z.string().nullable().optional(),
  activeAgentSessionStatus: aiAgentSessionStatusSchema.nullable().optional(),
  handoffReason: z.string().nullable().optional(),
  handoffActionCompletedAt: z.string().datetime().nullable().optional(),
  manualMarked: z.boolean().optional(),
  replyTriageDecision: z.enum(["needs_reply", "no_reply", "uncertain"]).nullable().optional(),
  replyTriageReason: z.string().nullable().optional(),
  replyTriageAnchorMessageId: z.string().nullable().optional(),
  sourceCampaign: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
  replyDismissed: z.boolean().optional()
});
export type ConversationDto = z.infer<typeof conversationSchema>;

export const inboxViewSchema = z.enum(["all", "unread", "marked", "reply", "handoff"]);
export type InboxView = z.infer<typeof inboxViewSchema>;

export const tagSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  color: z.string().min(1),
  useGuide: z.string(),
  isActive: z.boolean(),
  agentCount: z.number().int().min(0).optional(),
  conversationCount: z.number().int().min(0).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type TagDto = z.infer<typeof tagSchema>;

export const agentAllowedTagSchema = tagSchema.pick({
  id: true,
  name: true,
  color: true,
  useGuide: true
});
export type AgentAllowedTagDto = z.infer<typeof agentAllowedTagSchema>;

export const aiAgentTypeSchema = z.enum(["attendance", "prospecting"]);
export type AiAgentType = z.infer<typeof aiAgentTypeSchema>;
export const workspaceModulesSchema = z.object({ campaignProspecting: z.boolean().default(false) });
export type WorkspaceModules = z.infer<typeof workspaceModulesSchema>;

export const aiAgentSchema = z.object({
  type: aiAgentTypeSchema.default("attendance").optional(),
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  status: aiAgentStatusSchema,
  providerMode: aiProviderModeSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  systemPrompt: z.string().min(1),
  behaviorConfig: z.record(z.string(), z.unknown()),
  handoffConfig: z.record(z.string(), z.unknown()),
  limitsConfig: z.record(z.string(), z.unknown()),
  allowedActions: z.array(aiAgentAllowedActionSchema),
  allowedTags: z.array(agentAllowedTagSchema).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type AiAgentDto = z.infer<typeof aiAgentSchema>;

export const aiKnowledgeSourceSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  type: z.enum(["faq", "text", "file"]),
  title: z.string().min(1),
  content: z.string().nullable(),
  fileUrl: z.string().nullable(),
  fileName: z.string().nullable(),
  mimeType: z.string().nullable(),
  status: z.enum(["ready", "processing", "failed"]),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type AiKnowledgeSourceDto = z.infer<typeof aiKnowledgeSourceSchema>;

export const aiAgentImprovementStatusSchema = z.enum(["pending", "accepted", "rejected"]);
export const aiAgentImprovementKindSchema = z.enum(["not_sold", "made_to_order", "policy", "faq"]);
export const aiAgentImprovementClarificationQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  help: z.string().min(1)
});
export const aiAgentImprovementScopeSchema = z.enum([
  "requested_item_only",
  "requested_item_variations",
  "material_or_finish_family",
  "broader_catalog_scope"
]);
export const aiAgentImprovementNormalizationSchema = z.object({
  scope: aiAgentImprovementScopeSchema,
  confidence: z.number().min(0).max(1),
  requiresHandoffOutsideScope: z.boolean()
});

export const aiAgentImprovementSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  conversationId: z.string().min(1),
  sourceMessageId: z.string().min(1),
  status: aiAgentImprovementStatusSchema,
  kind: aiAgentImprovementKindSchema,
  title: z.string().min(1),
  content: z.string().min(1),
  rationale: z.string().nullable(),
  sourceCustomerMessage: z.string().min(1),
  sourceHumanReply: z.string().min(1),
  detector: z.record(z.string(), z.unknown()),
  clarification: z.object({
    questions: z.array(aiAgentImprovementClarificationQuestionSchema).max(3),
    answers: z.record(z.string(), z.string()),
    normalization: aiAgentImprovementNormalizationSchema.nullable()
  }),
  reviewedAt: z.string().datetime().nullable(),
  acceptedKnowledgeSourceId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type AiAgentImprovementDto = z.infer<typeof aiAgentImprovementSchema>;

export const aiAgentSessionSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  conversationId: z.string().min(1),
  status: aiAgentSessionStatusSchema,
  messageCount: z.number().int().min(0),
  lastRunAt: z.string().datetime().nullable(),
  handoffReason: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type AiAgentSessionDto = z.infer<typeof aiAgentSessionSchema>;

export const aiAgentRunSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  sessionId: z.string().min(1).nullable(),
  conversationId: z.string().min(1).nullable(),
  trigger: z.enum(["automation", "manual_test"]),
  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()),
  actions: z.array(z.record(z.string(), z.unknown())),
  status: aiAgentRunStatusSchema,
  confidence: z.number().min(0).max(1).nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string().datetime()
});
export type AiAgentRunDto = z.infer<typeof aiAgentRunSchema>;

export const messageSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  conversationId: z.string().min(1),
  providerMessageId: z.string().nullable(),
  direction: messageDirectionSchema,
  type: messageTypeSchema,
  body: z.string().nullable(),
  senderName: z.string().nullable().optional(),
  senderJid: z.string().nullable().optional(),
  mediaUrl: z.string().url().nullable(),
  mediaSourceHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  contactCards: z.array(z.object({
    fullName: z.string(),
    phoneNumber: z.string().nullable()
  })).optional(),
  location: messageLocationSchema.optional(),
  attachmentReadStatus: z.literal('unread').optional(),
  attachment: z.object({
    fileName: z.string().optional(),
    caption: z.string().optional(),
    mimeType: z.string().optional(),
    durationSeconds: z.number().nonnegative().optional(),
    /** WhatsApp GIFs are short muted MP4s that play on their own, in a loop. */
    isGif: z.boolean().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional()
  }).optional(),
  status: messageStatusSchema,
  sentByUserId: z.string().nullable(),
  editedAt: z.string().datetime().optional(),
  /** Sent by the seller's supervisor from the supervision view: the seller sees who answered. */
  sentBySupervisor: z.boolean().optional(),
  /** Forwarded from another conversation in Talk (shown to the team as "Encaminhada"). */
  forwarded: z.boolean().optional(),
  deletedAt: z.string().datetime().optional(),
  /** WhatsApp's id of this message (stanza id): replies and reactions point to it. */
  whatsappId: z.string().optional(),
  /** The message this one replies to, as WhatsApp quoted it. */
  quoted: z.object({ whatsappId: z.string(), participant: z.string().nullable(), body: z.string().nullable() }).optional(),
  /** This message is a reaction (emoji null = removed) to the message with this WhatsApp id; shown on that message. */
  reaction: z.object({ targetWhatsappId: z.string(), emoji: z.string().nullable() }).optional(),
  /** This message is a vote on the poll with this WhatsApp id (options null = vote not readable); counted on that poll. */
  pollVote: z.object({ targetWhatsappId: z.string(), options: z.array(z.string()).nullable() }).optional(),
  createdAt: z.string().datetime()
});
export type MessageDto = z.infer<typeof messageSchema>;

/** seller_reminder: the company owes the next step, so the card is a reminder for the seller, never a customer message. */
export const conversationFollowupKindSchema = z.enum(["qualification", "human_commercial", "seller_reminder"]);
export type ConversationFollowupKind = z.infer<typeof conversationFollowupKindSchema>;

export const conversationFollowupStatusSchema = z.enum([
  "evaluating",
  "scheduled",
  "processing",
  "review",
  "sent",
  "cancelled",
  "skipped",
  "expired",
  "failed"
]);
export type ConversationFollowupStatus = z.infer<typeof conversationFollowupStatusSchema>;

export const conversationFollowupPurposeSchema = z.enum([
  "missing_qualification",
  "proposal_checkin",
  "objection_help",
  "confirm_active",
  "none"
]);
export type ConversationFollowupPurpose = z.infer<typeof conversationFollowupPurposeSchema>;

export const conversationFollowupReasonCodeSchema = z.enum([
  "jev_human_review",
  "automatic_delivery_not_allowed",
  "history_requires_review",
  "conversation_context_limit",
  "manual_postponed",
  "manual_send_failed",
  "jev_followup_decision_unavailable",
  "reply_preflight_unavailable",
  "reply_audit_unavailable",
  "outbound_delivery_unconfirmed",
  "agent_unavailable",
  "context_unavailable",
  "handoff_required",
  "provider_reply_missing",
  "audit_blocked",
  "seller_reminder",
  "followup_brain_unavailable"
]);
export type ConversationFollowupReasonCode = z.infer<typeof conversationFollowupReasonCodeSchema>;

/** What the follow-up AI read in the conversation, shown on the card. */
export const conversationFollowupAnalysisSchema = z.object({
  situation: z.enum(["waiting_customer", "waiting_company", "closed", "no_pending"]),
  pendingItem: z.string().nullable(),
  nextStep: z.string().nullable(),
  timingNote: z.string().nullable(),
  rationale: z.string(),
  confidence: z.number().min(0).max(1)
});
export type ConversationFollowupAnalysisDto = z.infer<typeof conversationFollowupAnalysisSchema>;

const conversationFollowupBaseSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  conversationId: z.string().min(1),
  agentId: z.string().min(1),
  kind: conversationFollowupKindSchema,
  stepIndex: z.number().int().min(0),
  scheduledAt: z.string().datetime(),
  draftBody: z.string().nullable(),
  contact: z.object({
    name: z.string().nullable(),
    phone: z.string().nullable()
  }),
  channel: z.object({
    displayName: z.string().nullable()
  }),
  anchorMessage: z.object({
    id: z.string().nullable(),
    body: z.string().nullable(),
    type: messageTypeSchema.nullable(),
    createdAt: z.string().datetime().nullable()
  }),
  purpose: conversationFollowupPurposeSchema.nullable(),
  reasonCode: conversationFollowupReasonCodeSchema.nullable(),
  analysis: conversationFollowupAnalysisSchema.nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const conversationFollowupSchema = z.discriminatedUnion("status", [
  conversationFollowupBaseSchema.extend({ status: z.literal("evaluating") }),
  conversationFollowupBaseSchema.extend({ status: z.literal("scheduled") }),
  conversationFollowupBaseSchema.extend({ status: z.literal("processing") }),
  conversationFollowupBaseSchema.extend({ status: z.literal("review") }),
  conversationFollowupBaseSchema.extend({
    status: z.literal("sent"),
    finalBody: z.string(),
    sentAt: z.string().datetime(),
    sentByUserId: z.string().min(1).nullable()
  }),
  conversationFollowupBaseSchema.extend({
    status: z.literal("cancelled"),
    reason: z.string().min(1),
    cancelledAt: z.string().datetime(),
    cancelledByUserId: z.string().min(1).nullable()
  }),
  conversationFollowupBaseSchema.extend({
    status: z.literal("skipped"),
    reason: z.string().min(1)
  }),
  conversationFollowupBaseSchema.extend({
    status: z.literal("expired"),
    reason: z.string().min(1)
  }),
  conversationFollowupBaseSchema.extend({
    status: z.literal("failed"),
    reason: z.string().min(1)
  })
]);
export type ConversationFollowupDto = z.infer<typeof conversationFollowupSchema>;
