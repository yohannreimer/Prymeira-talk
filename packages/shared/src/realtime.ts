import { z } from "zod";
import { conversationSchema, messageSchema, messageStatusSchema } from "./domain";

export const realtimeEventSchema = z
  .discriminatedUnion("type", [
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
        status: messageStatusSchema
      })
    }),
    z.object({
      type: z.literal("conversation.updated"),
      workspaceId: z.string().min(1),
      payload: conversationSchema
    })
  ])
  .superRefine((event, context) => {
    if (
      (event.type === "message.created" || event.type === "conversation.updated") &&
      event.payload.workspaceId !== event.workspaceId
    ) {
      context.addIssue({
        code: "custom",
        message: "Payload workspaceId must match event workspaceId",
        path: ["payload", "workspaceId"]
      });
    }
  });

export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;
