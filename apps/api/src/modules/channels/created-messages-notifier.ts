import type { PrismaClient } from '@prisma/client';
import type { RealtimeEvent } from '@prymeira-talk/shared';
import { createConversationsService, toMessageDto, type PrismaLike } from '../conversations/conversations.service.js';

/** Live updates for messages written outside a request (imported history, gap recovery): the message and its
 * conversation reach open inboxes without a reload. In the worker, `publish` is the realtime bridge to the API. */
export function createCreatedMessagesNotifier(db: PrismaClient, publish: (event: RealtimeEvent) => void) {
  const conversations = createConversationsService(db as unknown as PrismaLike);
  return async (workspaceId: string, created: Array<{ messageId: string; conversationId: string }>) => {
    for (const { messageId } of created) {
      const message = await db.message.findFirst({ where: { workspaceId, id: messageId } });
      if (message) publish({ type: 'message.created', workspaceId, payload: toMessageDto(message as never) });
    }
    for (const conversationId of new Set(created.map(item => item.conversationId))) {
      publish({ type: 'conversation.updated', workspaceId, payload: await conversations.getConversationDto({ workspaceId, conversationId }) });
    }
  };
}
