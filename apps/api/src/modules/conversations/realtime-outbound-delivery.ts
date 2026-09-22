import { conversationSchema, messageSchema, type RealtimeEvent } from "@prymeira-talk/shared";
import type { ConversationOutboundTextDelivery } from "./conversations.service.js";

export function createRealtimeOutboundDelivery(input: {
  delivery: ConversationOutboundTextDelivery;
  realtime: { publish(event: RealtimeEvent): void };
}): ConversationOutboundTextDelivery {
  return {
    async createPendingOutboundMessage(deliveryInput) {
      const result = await input.delivery.createPendingOutboundMessage(deliveryInput);
      const message = messageSchema.safeParse(result.message);
      if (message.success) {
        input.realtime.publish({ type: "message.created", workspaceId: message.data.workspaceId, payload: message.data });
      }
      const conversation = conversationSchema.safeParse(result.conversation);
      if (conversation.success) {
        input.realtime.publish({ type: "conversation.updated", workspaceId: conversation.data.workspaceId, payload: conversation.data });
      }
      return result;
    }
  };
}
