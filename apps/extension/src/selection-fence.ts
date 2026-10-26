import type { SelectedContext, WaSelection } from './protocol';
export type LiveSelection = { windowId: number; tabId: number | null; selection: WaSelection | null };
export function assertSelection(expected: SelectedContext, live: LiveSelection) {
  if (live.windowId !== expected.windowId || live.tabId !== expected.tabId || live.selection?.key !== expected.key || live.selection.phase !== 'ready')
    throw new Error('A conversa mudou. Aguarde o painel atualizar.');
}
export async function withSelectionFence<T>(expected: SelectedContext, read: () => Promise<LiveSelection>, operation: () => Promise<T>): Promise<T> {
  assertSelection(expected, await read());
  const result = await operation();
  assertSelection(expected, await read());
  return result;
}
