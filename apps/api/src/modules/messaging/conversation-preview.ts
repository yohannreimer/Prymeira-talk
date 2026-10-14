import type { Prisma } from '@prisma/client';
import type { TrustedMessagingContext } from './normalized-event.js';
import { enterCanonicalTransaction } from './canonical-boundary.js';
type Tx = Prisma.TransactionClient;
interface PreviewInput {
    conversationId: string;
    messageId: string;
    preview: string | null;
}
async function lockPreview(tx: Tx, source: TrustedMessagingContext, input: PreviewInput) {
    await enterCanonicalTransaction(tx, source);
    const rows = await tx.$queryRaw<Array<{
        id: string;
    }>> `SELECT id FROM conversations WHERE workspace_id=${source.workspaceId} AND channel_id=${source.channelId}::uuid AND id=${input.conversationId}::uuid FOR UPDATE`;
    if (!rows.length)
        throw new Error('Preview conversation scope mismatch');
    const conversation = await tx.conversation.findUniqueOrThrow({ where: { workspaceId_id: { workspaceId: source.workspaceId, id: input.conversationId } } });
    const owner = await tx.conversationPreviewOwner.findUnique({ where: { conversationId: conversation.id } });
    return { conversation, owner };
}
async function writePreview(tx: Tx, source: TrustedMessagingContext, input: PreviewInput, previewAt: Date | null) {
    // The trigger invalidates ALL cache writers, including this one. Reassert only
    // this explicitly selected UUID after the cache write, in the same transaction.
    await tx.conversation.update({ where: { workspaceId_id: { workspaceId: source.workspaceId, id: input.conversationId } }, data: { lastMessagePreview: input.preview, lastMessagePreviewAt: previewAt } });
    await tx.conversationPreviewOwner.create({ data: { workspaceId: source.workspaceId, channelId: source.channelId, conversationId: input.conversationId, messageId: input.messageId } });
}
/** A new canonical Message may advance a known equal-clock preview once. Mirrors
 * and echoes cannot steal a different UUID's tie. Missing legacy proof is never
 * inferred from timestamp/body: only strictly newer time (preview or prior activity)
 * or an empty cache selects.
 */
export async function selectConversationPreviewInTransaction(tx: Tx, source: TrustedMessagingContext, input: PreviewInput & {
    selection: 'new_message' | 'echo';
}) {
    const { conversation, owner } = await lockPreview(tx, source, input);
    const message = await tx.message.findUniqueOrThrow({ where: { workspaceId_conversationId_id: { workspaceId: source.workspaceId, conversationId: input.conversationId, id: input.messageId } } });
    const owns = owner?.messageId === message.id, clock = conversation.lastMessagePreviewAt;
    if (owns) {
        await writePreview(tx, source, input, clock);
        return true;
    }
    const empty = clock === null && conversation.lastMessagePreview === null;
    // Callers select before advancing activity. A legacy preview without its own
    // clock may be superseded only beyond the previous activity clock; that clock
    // orders a new selection and never proves ownership of the cached content.
    const orderingClock = clock ?? conversation.lastMessageAt;
    const newer = orderingClock !== null && orderingClock.getTime() < message.createdAt.getTime();
    const tiedNew = clock !== null && clock.getTime() === message.createdAt.getTime() && !!owner && input.selection === 'new_message';
    if (!empty && !newer && !tiedNew)
        return false;
    await writePreview(tx, source, input, message.createdAt);
    return true;
}
/** Content changes authorize preview replacement only through a persisted exact
 * Message owner. The original preview clock and inbox visibility are preserved. */
export async function refreshOwnedConversationPreviewInTransaction(tx: Tx, source: TrustedMessagingContext, input: PreviewInput) {
    const { conversation, owner } = await lockPreview(tx, source, input);
    if (owner?.messageId !== input.messageId)
        return false;
    await writePreview(tx, source, input, conversation.lastMessagePreviewAt);
    return true;
}
