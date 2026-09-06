import type { PrismaClient, Prisma } from '@prisma/client';

export type AssistantDb = PrismaClient | Prisma.TransactionClient;
export type AssistantActor = { workspaceId: string; userId: string; role: 'owner' | 'manager' | 'agent' };
export class AssistantError extends Error {
  constructor(public code: string, message: string, public statusCode = 409) { super(message); }
}

export async function resolveAssistantActor(db: AssistantDb, auth: { workspaceId: string; clerkUserId?: string | null; role: AssistantActor['role'] }): Promise<AssistantActor> {
  if (!auth.clerkUserId) throw new AssistantError('ASSISTANT_PROFILE_REQUIRED', 'Conclua seu cadastro de usuário para usar a IA de apoio.', 422);
  const profile = await db.userProfile.findFirst({ where: { workspaceId: auth.workspaceId, clerkUserId: auth.clerkUserId } });
  if (!profile) throw new AssistantError('ASSISTANT_PROFILE_REQUIRED', 'Conclua seu cadastro de usuário para usar a IA de apoio.', 422);
  return { workspaceId: auth.workspaceId, userId: profile.id, role: auth.role };
}

export async function requireAssistantConversation(db: AssistantDb, actor: AssistantActor, conversationId: string) {
  const conversation = await db.conversation.findFirst({ where: { workspaceId: actor.workspaceId, id: conversationId }, include: { channel: true } });
  if (!conversation) throw new AssistantError('CONVERSATION_NOT_FOUND', 'Conversa não encontrada.', 404);
  if (actor.role === 'agent' && conversation.assignedUserId !== actor.userId) throw new AssistantError('ASSISTANT_FORBIDDEN', 'A IA de apoio está disponível nas conversas atribuídas a você.', 403);
  return conversation;
}

export function requireAssistantManager(actor: AssistantActor) {
  if (actor.role === 'agent') throw new AssistantError('ASSISTANT_FORBIDDEN', 'Somente gestores podem configurar a IA de apoio.', 403);
}

// Serialize publication, scheduling and explicit send for this conversation.
export async function lockAssistantConversation(tx: Prisma.TransactionClient, workspaceId: string, conversationId: string) {
  await tx.$queryRaw`SELECT id FROM conversations WHERE workspace_id = ${workspaceId} AND id = ${conversationId}::uuid FOR UPDATE`;
}
