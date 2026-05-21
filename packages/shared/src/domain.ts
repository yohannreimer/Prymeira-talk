import { z } from "zod";

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

export const conversationStatusSchema = z.enum(["open", "pending", "closed"]);
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;
export const conversationPrioritySchema = z.enum(["low", "normal", "high"]);
export type ConversationPriority = z.infer<typeof conversationPrioritySchema>;

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
  departmentName: z.string().nullable().optional(),
  assignedUserName: z.string().nullable().optional(),
  status: conversationStatusSchema,
  assignedUserId: z.string().nullable(),
  departmentId: z.string().nullable(),
  lastMessageAt: z.string().datetime().nullable(),
  lastMessagePreview: z.string().nullable(),
  unreadCount: z.number().int().min(0),
  priority: conversationPrioritySchema
});
export type ConversationDto = z.infer<typeof conversationSchema>;

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
