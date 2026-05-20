import { z } from "zod";

export const userRoleSchema = z.enum(["owner", "manager", "agent"]);
export type UserRole = z.infer<typeof userRoleSchema>;

export const conversationStatusSchema = z.enum(["open", "pending", "closed"]);
export const conversationPrioritySchema = z.enum(["low", "normal", "high"]);

export const messageDirectionSchema = z.enum(["inbound", "outbound"]);
export const messageTypeSchema = z.enum(["text", "image", "audio", "file", "template", "system", "internal_note"]);
export const messageStatusSchema = z.enum(["pending", "sent", "delivered", "read", "failed"]);

export const conversationSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  channelId: z.string().min(1),
  contactId: z.string().min(1),
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
  providerMessageId: z.string().nullable().optional(),
  direction: messageDirectionSchema,
  type: messageTypeSchema,
  body: z.string().nullable(),
  mediaUrl: z.string().url().nullable().optional(),
  status: messageStatusSchema,
  sentByUserId: z.string().nullable().optional(),
  createdAt: z.string().datetime()
});
export type MessageDto = z.infer<typeof messageSchema>;
