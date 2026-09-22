export function takeLeadDraftRequest(href: string, conversationId: string) {
  const url = new URL(href);
  if (url.searchParams.get("leadDraft") !== "1" || url.searchParams.get("conversation") !== conversationId) return null;
  url.searchParams.delete("leadDraft");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function mergeLeadComposerDraft(current: string, incoming: string | null | undefined) {
  return current.trim() || !incoming?.trim() ? current : incoming;
}
