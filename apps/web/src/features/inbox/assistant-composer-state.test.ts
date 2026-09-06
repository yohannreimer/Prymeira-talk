import { it, expect } from 'vitest';
import { canCopySuggestion, draftNeedsReview } from './assistant-composer-state';
it('does not replace existing text without confirmation', () => { expect(canCopySuggestion('meu texto')).toBe(false); expect(canCopySuggestion('meu texto', true)).toBe(true); expect(canCopySuggestion('')).toBe(true); });
it('marks copied text for review after the context changes without editing its body', () => {
  const origin = { conversationId: 'c', suggestionId: 's', originalBody: 'meu texto', contextKey: 'old', requestKey: 'r' };
  expect(draftNeedsReview(origin, 'new')).toBe(true); expect(draftNeedsReview(origin, 'old')).toBe(false); expect(origin.originalBody).toBe('meu texto');
});
