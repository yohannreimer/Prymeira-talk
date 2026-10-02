/** Conversations retired into this one by an authority resolution keep their own rows; whoever reads this
 * conversation's history (inbox, agent, assistant, handoff brief) reads theirs too, as one history. */
type ScopeDb = { conversation?: { findMany?: (args: { where: { workspaceId: string; retiredIntoConversationId: string }; select: { id: true } }) => Promise<Array<{ id: string }>> } };

export async function conversationHistoryScope(db: unknown, workspaceId: string, conversationId: string): Promise<string | { in: string[] }> {
  const finder = (db as ScopeDb)?.conversation?.findMany;
  if (typeof finder !== 'function') return conversationId;
  const retired = await (db as Required<ScopeDb>).conversation.findMany!({ where: { workspaceId, retiredIntoConversationId: conversationId }, select: { id: true } }).catch(() => []);
  const ids = Array.isArray(retired) ? retired.map(row => row?.id).filter((id): id is string => typeof id === 'string' && id !== conversationId) : [];
  return ids.length ? { in: [conversationId, ...ids] } : conversationId;
}
