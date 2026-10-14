import type { Prisma } from '@prisma/client';
type Tx = Prisma.TransactionClient;
type Scope = {
    workspaceId: string;
    channelId: string;
};
/** Follow persisted address redirects without changing immutable intent snapshots. */
export async function outboundChatRoot(tx: Tx, scope: Scope, chatId: string) {
    scope = { workspaceId: scope.workspaceId, channelId: scope.channelId };
    const chat = await tx.canonicalChat.findFirst({ where: { ...scope, id: chatId } });
    if (!chat)
        return null;
    let address = await tx.canonicalAddress.findFirst({ where: { ...scope, id: chat.addressId } });
    const seen = new Set<string>();
    while (address?.redirectId) {
        if (seen.has(address.id) || address.state === 'review')
            return null;
        seen.add(address.id);
        address = await tx.canonicalAddress.findFirst({ where: { ...scope, id: address.redirectId } });
    }
    if (!address || address.state === 'review')
        return null;
    return tx.canonicalChat.findFirst({ where: { ...scope, addressId: address.id } });
}
