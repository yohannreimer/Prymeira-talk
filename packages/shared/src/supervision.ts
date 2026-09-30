import { z } from "zod";
import { conversationSchema, messageSchema } from "./domain.js";

export const supervisionUnreadPeriodSchema = z.enum(["all", "24h", "7d"]);
export type SupervisionUnreadPeriod = z.infer<typeof supervisionUnreadPeriodSchema>;

export const supervisionGrantSchema = z.object({
  id: z.string().uuid(),
  supervisor_customer_id: z.string().uuid(),
  seller_customer_id: z.string().uuid(),
  seller_name: z.string(),
  seller_email: z.string().email(),
  workspace_id: z.string().uuid(),
  channel_id: z.string().uuid()
});
export const supervisionAccessSchema = z.object({ grants: z.array(supervisionGrantSchema) });
export type SupervisionGrant = z.infer<typeof supervisionGrantSchema>;

export const supervisionSellerSchema = z.object({
  sellerCustomerId: z.string().uuid(),
  sellerName: z.string(),
  sellerEmail: z.string().email(),
  nextActionCount: z.number().int().nonnegative(),
  unreadConversationCount: z.number().int().nonnegative()
});
export const supervisionSummarySchema = z.object({ sellers: z.array(supervisionSellerSchema) });
export type SupervisionSummary = z.infer<typeof supervisionSummarySchema>;

export const supervisionConversationSchema = conversationSchema.extend({
  sellerCustomerId: z.string().uuid(),
  sellerName: z.string(),
  sellerEmail: z.string().email(),
  channelPhoneNumber: z.string().nullable()
});
export type SupervisionConversation = z.infer<typeof supervisionConversationSchema>;
export const supervisionPageSchema = z.object({
  conversations: z.array(supervisionConversationSchema),
  nextCursor: z.string().nullable()
});
export type SupervisionPage = z.infer<typeof supervisionPageSchema>;
export const supervisionThreadSchema = z.object({
  conversation: supervisionConversationSchema,
  messages: z.array(messageSchema)
});
export type SupervisionThread = z.infer<typeof supervisionThreadSchema>;

// The persistent handoff state defines a pending next action. Opening a thread
// and its local visual acknowledgement do not complete the seller's action.
export function needsHumanAttention(conversation: {
  status?: string;
  aiControlStatus?: string;
  activeAgentSessionStatus?: string | null;
  handoffReason?: string | null;
  handoffActionCompletedAt?: string | null;
}) {
  if (conversation.status === "closed" || conversation.handoffActionCompletedAt) return false;
  return conversation.activeAgentSessionStatus === "handoff_requested" ||
    (conversation.aiControlStatus === "human_controlled" && Boolean(conversation.handoffReason));
}
