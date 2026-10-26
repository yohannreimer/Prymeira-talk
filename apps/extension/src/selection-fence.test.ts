import { expect, it } from 'vitest';
import { withSelectionFence, assertSelection } from './selection-fence';
const expected = { windowId: 1, tabId: 7, key: 'chat-A', scope: 'account-A' };
const selection = { key: 'chat-A', phase: 'ready' as const, selfAddress: 'self', peerAddress: 'peer', label: 'Ana', lastMessageId: null };
it('drops a response if another conversation opens while the API is working', async () => {
  let live = { windowId: 1, tabId: 7, selection };
  await expect(withSelectionFence(expected, async () => live, async () => {
    live = { windowId: 1, tabId: 7, selection: { ...selection, key: 'chat-B' } }; return 'Suggestion for A';
  })).rejects.toThrow('conversa mudou');
});
it('checks the tab as well as the conversation before executing anything', async () => {
  let called = false;
  await expect(withSelectionFence(expected, async () => ({ windowId: 1, tabId: 8, selection }), async () => { called = true; })).rejects.toThrow();
  expect(called).toBe(false);
});
it('refuses switching and signed-out contexts', () => {
  expect(() => assertSelection(expected, { windowId: 1, tabId: 7, selection: { ...selection, phase: 'switching' } })).toThrow();
  expect(() => assertSelection(expected, { windowId: 1, tabId: 7, selection: null })).toThrow();
});
it('never accepts a matching chat key from another browser window', () => {
  expect(() => assertSelection(expected, { windowId: 2, tabId: 7, selection })).toThrow();
});
