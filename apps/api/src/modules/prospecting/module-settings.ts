import { lockProspectingConversations } from "./prospecting-lock.js";
import type { Prisma, PrismaClient } from '@prisma/client';
import { asRecord, stopProspectingConversation } from './prospecting-policy.js';

export async function lockWorkspaceSettings(tx: Prisma.TransactionClient, workspaceId: string) {
  // Materialize missing mirrors before locking; both settings writers use this
  // ordering so even first-write races serialize on the same row.
  await tx.workspaceMirror.upsert({ where: { workspaceId }, create: { workspaceId }, update: {} });
  await tx.$queryRaw`SELECT workspace_id FROM workspace_mirrors WHERE workspace_id = ${workspaceId} FOR UPDATE`;
}

export async function updateProspectingModule(prisma: PrismaClient, workspaceId: string, enabled: boolean) {
  return prisma.$transaction(async tx => {
    await lockWorkspaceSettings(tx, workspaceId);
    const current = await tx.workspaceMirror.findUnique({ where: { workspaceId } });
    const root = asRecord(current?.limits);
    const limits = { ...root, modules: { ...asRecord(root.modules), campaignProspecting: enabled } } as Prisma.InputJsonObject;
    await tx.workspaceMirror.upsert({ where: { workspaceId }, create: { workspaceId, limits }, update: { limits } });
    const stopped = enabled ? [] : await tx.campaignProspectingReservation.findMany({
      where: { workspaceId, status: { in: ['prepared', 'sending', 'confirmed'] } }, orderBy: { conversationId: 'asc' } });
    await lockProspectingConversations(tx, stopped);
    for (const row of stopped) await stopProspectingConversation(tx, workspaceId, row.conversationId, 'Módulo de prospecção desativado.');
    await tx.auditLog.create({ data: { workspaceId, action: 'settings.modules_updated', targetType: 'workspace_mirror', targetId: workspaceId,
      metadata: { campaignProspecting: enabled } } });
    return stopped.map(row => row.conversationId);
  });
}
