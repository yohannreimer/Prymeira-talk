import { z } from "zod";
import {
  channelSchema,
  contactBoardMembershipSchema,
  contactSchema,
  conversationSchema,
  integrationModeSchema,
  messageSchema,
  messageStatusSchema
} from "./domain.js";

const messageCreatedEventSchema = z.object({
  type: z.literal("message.created"),
  workspaceId: z.string().min(1),
  payload: messageSchema
});

const messageStatusChangedEventSchema = z.object({
  type: z.literal("message.status_changed"),
  workspaceId: z.string().min(1),
  payload: z.object({
    messageId: z.string().min(1),
    status: messageStatusSchema
  })
});

const conversationUpdatedEventSchema = z.object({
  type: z.literal("conversation.updated"),
  workspaceId: z.string().min(1),
  payload: conversationSchema
});

const contactUpdatedEventSchema = z.object({
  type: z.literal("contact.updated"),
  workspaceId: z.string().min(1),
  payload: contactSchema
});

const boardMembershipUpdatedEventSchema = z.object({
  type: z.literal("board_membership.updated"),
  workspaceId: z.string().min(1),
  payload: contactBoardMembershipSchema
});

const channelUpdatedEventSchema = z.object({
  type: z.literal("channel.updated"),
  workspaceId: z.string().min(1),
  payload: channelSchema
});

const channelQrUpdatedEventSchema = z.object({
  type: z.literal("channel.qr_updated"),
  workspaceId: z.string().min(1),
  payload: z.object({
    channelId: z.string().min(1),
    qrCode: z.string().min(1),
    expiresAt: z.string().datetime()
  })
});

const automationRunSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  ruleId: z.string().min(1),
  eventKey: z.string().min(1),
  status: z.string().min(1),
  input: z.unknown(),
  result: z.unknown(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

const automationRunCreatedEventSchema = z.object({
  type: z.literal("automation_run.created"),
  workspaceId: z.string().min(1),
  payload: automationRunSchema
});

const campaignSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(["draft", "scheduled", "sending", "completed", "failed"]),
  audience: z.unknown(),
  messageBody: z.string().min(1),
  scheduledAt: z.string().datetime().nullable(),
  mode: integrationModeSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

const campaignUpdatedEventSchema = z.object({
  type: z.literal("campaign.updated"),
  workspaceId: z.string().min(1),
  payload: campaignSchema
});

export const realtimeEventSchema = z
  .discriminatedUnion("type", [
    messageCreatedEventSchema,
    messageStatusChangedEventSchema,
    conversationUpdatedEventSchema,
    contactUpdatedEventSchema,
    boardMembershipUpdatedEventSchema,
    channelUpdatedEventSchema,
    channelQrUpdatedEventSchema,
    automationRunCreatedEventSchema,
    campaignUpdatedEventSchema
  ])
  .superRefine((event, context) => {
    const payload =
      typeof event.payload === "object" && event.payload !== null
        ? (event.payload as { workspaceId?: unknown })
        : null;

    if (typeof payload?.workspaceId === "string" && payload.workspaceId !== event.workspaceId) {
      context.addIssue({
        code: "custom",
        message: "Payload workspaceId must match event workspaceId",
        path: ["payload", "workspaceId"]
      });
    }
  });

export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;
