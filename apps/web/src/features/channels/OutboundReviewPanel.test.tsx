// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutboundReviewPanel } from './OutboundReviewPanel';

const mocks = vi.hoisted(() => ({ apiListOutboundReview: vi.fn(), apiResolveOutboundReview: vi.fn() }));
vi.mock('../../app/api', () => mocks);

const item = (id: string, over: Record<string, unknown> = {}) => ({ id, channelId: 'c', kind: 'text', destination: '5547999990000', preview: 'Segue o orçamento', errorCode: 'TimeoutError', createdAt: '2026-10-02T12:00:00.000Z', ...over });

describe('OutboundReviewPanel', () => {
  let root: Root; let container: HTMLDivElement;
  const getToken = async () => 'token';
  const button = (label: string, within: Element = container) => [...within.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)!;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    mocks.apiListOutboundReview.mockReset(); mocks.apiResolveOutboundReview.mockReset();
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it('renders nothing when there is nothing to review (and for people who may not see it)', async () => {
    mocks.apiListOutboundReview.mockResolvedValue([]);
    await act(async () => root.render(<OutboundReviewPanel getToken={getToken} />));
    expect(container.innerHTML).toBe('');
  });

  it('lists the uncertain sends with what was sent and to whom, and says nothing is resent', async () => {
    mocks.apiListOutboundReview.mockResolvedValue([item('a'), item('b', { kind: 'audio', preview: null })]);
    await act(async () => root.render(<OutboundReviewPanel getToken={getToken} />));
    expect(container.textContent).toContain('Envios em revisão (2)');
    expect(container.textContent).toContain('Segue o orçamento');
    expect(container.textContent).toContain('Áudio');
    expect(container.textContent).toContain('Nada é reenviado automaticamente');
  });

  it('records what the person found and removes only that item', async () => {
    mocks.apiListOutboundReview.mockResolvedValue([item('a'), item('b')]);
    mocks.apiResolveOutboundReview.mockResolvedValue(undefined);
    await act(async () => root.render(<OutboundReviewPanel getToken={getToken} />));
    const first = container.querySelector('[data-dispatch-id="a"]')!;
    await act(async () => button('Chegou ao cliente', first).click());
    expect(mocks.apiResolveOutboundReview).toHaveBeenCalledWith(getToken, 'a', true);
    expect(container.querySelector('[data-dispatch-id="a"]')).toBeNull();
    const second = container.querySelector('[data-dispatch-id="b"]')!;
    await act(async () => button('Não chegou', second).click());
    expect(mocks.apiResolveOutboundReview).toHaveBeenLastCalledWith(getToken, 'b', false);
    expect(container.innerHTML).toBe('');
  });

  it('keeps the item and shows the problem when saving fails', async () => {
    mocks.apiListOutboundReview.mockResolvedValue([item('a')]);
    mocks.apiResolveOutboundReview.mockRejectedValue(new Error('Envio não encontrado ou já resolvido.'));
    await act(async () => root.render(<OutboundReviewPanel getToken={getToken} />));
    await act(async () => button('Não chegou').click());
    expect(container.querySelector('[data-dispatch-id="a"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('já resolvido');
  });
});
