import { z } from "zod";
import { conversationSchema, messageSchema } from "./domain";

export const realtimeEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message.created"),
    workspaceId: z.string().min(1),
    payload: messageSchema
  }),
  z.object({
    type: z.literal("message.status_changed"),
    workspaceId: z.string().min(1),
    payload: z.object({
      messageId: z.string().min(1),
      status: z.enum(["pending", "sent", "delivered", "read", "failed"])
    })
  }),
  z.object({
    type: z.literal("conversation.updated"),
    workspaceId: z.string().min(1),
    payload: conversationSchema
  })
]);

export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;
