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

export const channelSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  provider: channelProviderSchema,
  providerKey: z.string().min(1),
  phoneNumber: z.string().nullable(),
  displayName: z.string().nullable(),
  status: channelStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type ChannelDto = z.infer<typeof channelSchema>;

export const channelOperationResultSchema = z.object({
  mode: integrationModeSchema,
  channel: channelSchema
});
export type ChannelOperationResultDto = z.infer<typeof channelOperationResultSchema>;

export const channelQrResultSchema = channelOperationResultSchema.extend({
  qrCode: z.string().min(1),
  qr: z.object({
    payload: z.string().min(1),
    expiresAt: z.string().datetime()
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
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type ContactDto = z.infer<typeof contactSchema>;

export const contactBoardSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  createdAt: z.string().datetime()
});
export type ContactBoardDto = z.infer<typeof contactBoardSchema>;

export const contactBoardStageSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  boardId: z.string().min(1),
  name: z.string().min(1),
  color: z.string().min(1),
  order: z.number().int().min(0)
});
export type ContactBoardStageDto = z.infer<typeof contactBoardStageSchema>;

export const contactBoardMembershipSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  contactId: z.string().min(1),
  boardId: z.string().min(1),
  stageId: z.string().min(1),
  isPrimary: z.boolean(),
  updatedAt: z.string().datetime()
});
export type ContactBoardMembershipDto = z.infer<typeof contactBoardMembershipSchema>;

export const conversationSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  channelId: z.string().min(1),
  contactId: z.string().min(1),
  contactName: z.string().nullable().optional(),
  contactPhone: z.string().nullable().optional(),
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
  lastMessagePreview: z.string().nullable(),
  unreadCount: z.number().int().min(0),
  priority: conversationPrioritySchema,
  aiControlStatus: aiControlStatusSchema.optional(),
  activeAgentName: z.string().nullable().optional(),
  activeAgentSessionStatus: aiAgentSessionStatusSchema.nullable().optional(),
  handoffReason: z.string().nullable().optional()
});
export type ConversationDto = z.infer<typeof conversationSchema>;

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

export const aiAgentSchema = z.object({
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
  mediaUrl: z.string().url().nullable(),
  status: messageStatusSchema,
  sentByUserId: z.string().nullable(),
  createdAt: z.string().datetime()
});
export type MessageDto = z.infer<typeof messageSchema>;
