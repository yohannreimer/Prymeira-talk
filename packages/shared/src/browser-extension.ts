import { z } from 'zod';
import type { AssistantConversationDto } from './assistant.js';
import type { ConversationFollowupDto } from './domain.js';

/** Browser observations locate a chat; they never authorize access to it. */
export const extensionChatSchema = z.object({
  channelId: z.string().uuid(),
  selfAddress: z.string().min(1).max(100),
  peerAddress: z.string().min(1).max(100).nullable(),
  lastMessageId: z.string().min(1).max(250).nullable().optional(),
}).strict();
export type ExtensionChat = z.infer<typeof extensionChatSchema>;
export const extensionAccountSchema = z.object({ channelId: z.string().uuid(), selfAddress: z.string().min(1).max(100) }).strict();
export const extensionQueueKindSchema = z.enum(['review', 'reminders', 'scheduled', 'human']);
export type ExtensionAccount = z.infer<typeof extensionAccountSchema>;
export type ExtensionQueueKind = z.infer<typeof extensionQueueKindSchema>;
export const extensionQueueQuerySchema = z.object({ account: extensionAccountSchema, kind: extensionQueueKindSchema, cursor: z.string().uuid().optional() }).strict();
export const extensionNavigationSchema = z.object({ account: extensionAccountSchema, kind: extensionQueueKindSchema, id: z.string().uuid(), expectedUpdatedAt: z.string().datetime({ offset: true }).optional() }).strict();
export type ExtensionQueueQuery = z.infer<typeof extensionQueueQuerySchema>;
export type ExtensionNavigation = z.infer<typeof extensionNavigationSchema>;
export type ExtensionQueueItem = { id: string; conversation: ExtensionConversation; reason: string | null;
  followup: { id: string; kind: string; status: string; scheduledAt: string; updatedAt: string } | null };
export type ExtensionQueue = { kind: ExtensionQueueKind; items: ExtensionQueueItem[]; counts: Record<ExtensionQueueKind, number>; nextCursor: string | null };
export type ExtensionNavigationTarget = { conversation: ExtensionConversation; prepare: { id: string; expectedUpdatedAt: string } | null };
export const extensionCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('session') }).strict(),
  z.object({ action: z.literal('queue'), ...extensionQueueQuerySchema.shape }).strict(),
  z.object({ action: z.literal('navigate'), ...extensionNavigationSchema.shape }).strict(),
  z.object({ action: z.literal('cancel-followup'), account: extensionAccountSchema, id: z.string().uuid(), expectedUpdatedAt: z.string().datetime({offset:true}) }).strict(),
  z.object({ action: z.literal('complete-handoff'), account: extensionAccountSchema, id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('read'), chat: extensionChatSchema }).strict(),
  z.object({ action: z.literal('generate'), chat: extensionChatSchema, instruction: z.string().trim().max(2000).optional() }).strict(),
  z.object({ action: z.literal('followup'), chat: extensionChatSchema, id: z.string().uuid(),
    operation: z.enum(['postpone', 'cancel', 'done', 'no-followup']), expectedUpdatedAt: z.string().datetime({ offset: true }) }).strict(),
]);
export type ExtensionCommand = z.infer<typeof extensionCommandSchema>;
export type ExtensionChannel = { id: string; displayName: string | null; phoneNumber: string; status: string };
export type ExtensionSession = { scope: string; workspaceId: string; role: string; channels: ExtensionChannel[] };
export type ExtensionConversation = { id: string; contactName: string | null; phone: string; channelId: string };
export type ExtensionRead = { scope: string; conversation: ExtensionConversation; assistant: AssistantConversationDto;
  followup: ConversationFollowupDto | null };
export type ExtensionReply = { ok: true; data: ExtensionSession | ExtensionRead | (ExtensionQueue & { scope: string }) | (ExtensionNavigationTarget & { scope: string }) | { accepted: true; scope: string } }
  | { ok: false; error: string; code?: string };
export const EXTENSION_BRIDGE_REQUEST = 'prymeira:extension:request:v1';
export const EXTENSION_BRIDGE_RESPONSE = 'prymeira:extension:response:v1';
export const EXTENSION_BRIDGE_STATUS = 'prymeira:extension:status:v1';
export const EXTENSION_BRIDGE_PING = 'prymeira:extension:ping:v1';
export const EXTENSION_BRIDGE_DISCONNECT = 'prymeira:extension:disconnect:v1';
