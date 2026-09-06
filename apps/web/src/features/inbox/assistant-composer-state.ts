import type { AssistantSuggestionDto } from '@prymeira-talk/shared';
export type ComposerSuggestionOrigin = { conversationId: string; suggestionId: string; originalBody: string; contextKey: string; requestKey: string };
export function suggestionOrigin(suggestion: AssistantSuggestionDto): ComposerSuggestionOrigin {
  return { conversationId: suggestion.conversationId, suggestionId: suggestion.id, originalBody: suggestion.body, contextKey: suggestion.contextKey, requestKey: crypto.randomUUID() };
}
export function canCopySuggestion(body: string, confirmed = false) { return !body.trim() || confirmed; }
export function draftNeedsReview(origin: ComposerSuggestionOrigin | null, currentContextKey: string | null | undefined) {
  return Boolean(origin && origin.contextKey !== currentContextKey);
}
