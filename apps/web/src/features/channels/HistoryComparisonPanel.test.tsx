// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryComparisonPanel } from './HistoryComparisonPanel';

const mocks = vi.hoisted(() => ({ apiCompareChannelHistory: vi.fn() }));
vi.mock('../../app/api', () => mocks);

describe('HistoryComparisonPanel', () => {
  let root: Root; let container: HTMLDivElement;
  beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); mocks.apiCompareChannelHistory.mockReset(); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  it('compares on request and shows totals, per-chat rows and skipped LID chats', async () => {
    mocks.apiCompareChannelHistory.mockResolvedValue({ totals: { evolution: 10, waha: 12, onlyEvolution: 1, onlyWaha: 3, both: 9 }, skippedLidChats: 2,
      chats: [{ chatAddress: '554799990003@s.whatsapp.net', evolution: 10, waha: 12, onlyEvolution: 1, onlyWaha: 3, both: 9 }] });
    await act(async () => root.render(<HistoryComparisonPanel channelId="c1" getToken={async () => 't'} />));
    expect(mocks.apiCompareChannelHistory).not.toHaveBeenCalled();
    await act(async () => container.querySelector('button')!.click());
    expect(mocks.apiCompareChannelHistory).toHaveBeenCalledWith(expect.any(Function), 'c1');
    expect(container.textContent).toContain('Só WAHA3');
    expect(container.textContent).toContain('554799990003');
    expect(container.textContent).toContain('2 conversa(s)');
  });
  it('shows a provider failure', async () => {
    mocks.apiCompareChannelHistory.mockRejectedValue(new Error('Um dos provedores não respondeu'));
    await act(async () => root.render(<HistoryComparisonPanel channelId="c1" getToken={async () => 't'} />));
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('não respondeu');
  });
});
