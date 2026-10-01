// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useHandoffBrief } from './useHandoffBrief';
import { apiGetHandoffBrief } from '../../app/api';
import type { HandoffBriefDto } from '../../../../../packages/shared/src/assistant';
vi.mock('../../app/api', () => ({ apiGetHandoffBrief: vi.fn() }));
const token = async () => 'token';
const ready: HandoffBriefDto = { status: 'ready', nextAction: 'Verifique o material.', summary: 'Quatro peças.', contextKey: 'one', updatedAt: '2026-09-22T19:00:00Z', error: null };
function ContextProbe({ id, activity }: { id: string; activity: string }) {
  const { data } = useHandoffBrief(id, true, activity, token);
  return <span>{data?.status ?? 'none'}:{data?.nextAction ?? 'none'}</span>;
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
describe('handoff processing GET', () => {
  it("does not carry a previous conversation's brief across selection", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.mocked(apiGetHandoffBrief).mockResolvedValueOnce(ready).mockResolvedValueOnce({ ...ready, nextAction: 'Faça a proposta.', contextKey: 'two' });
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
    try {
      await act(async () => root.render(<ContextProbe id="conversation-one" activity="t1" />));
      expect(container.textContent).toContain('Verifique o material.');
      await act(async () => root.render(<ContextProbe id="conversation-two" activity="t2" />));
      expect(container.textContent).toContain('Faça a proposta.');
      expect(container.textContent).not.toContain('Verifique o material.');
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
  it('requests an updated brief when the latest message changes', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.mocked(apiGetHandoffBrief).mockResolvedValue(ready);
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
    try {
      await act(async () => root.render(<ContextProbe id="conversation-one" activity="t1" />));
      expect(apiGetHandoffBrief).toHaveBeenCalledTimes(1);
      await act(async () => root.render(<ContextProbe id="conversation-one" activity="t2" />));
      expect(apiGetHandoffBrief).toHaveBeenCalledTimes(2);
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
  it('stops polling on error, preserves its gate, and recovers only on an explicit trigger', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers();
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
    function Probe({ enabled = true }: { enabled?: boolean }) {
      const brief = useHandoffBrief('c1', enabled, null, token);
      return <><span>{brief.error ?? brief.data?.nextAction}</span><button onClick={brief.refresh}>Retry</button></>;
    }
    vi.mocked(apiGetHandoffBrief).mockRejectedValue(new Error('failure'));
    await act(async () => root.render(<Probe />)); expect(container.textContent).toContain('failure');
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); document.dispatchEvent(new Event('visibilitychange')); });
    expect(apiGetHandoffBrief).toHaveBeenCalledOnce();
    vi.mocked(apiGetHandoffBrief).mockResolvedValue({ status: 'ready', nextAction: 'Recovered', summary: null, contextKey: null, updatedAt: null, error: null });
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    expect(container.textContent).toContain('Recovered'); expect(apiGetHandoffBrief).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); }); expect(apiGetHandoffBrief).toHaveBeenCalledTimes(3);
    await act(async () => root.render(<Probe enabled={false} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); }); expect(apiGetHandoffBrief).toHaveBeenCalledTimes(3);
    await act(async () => root.unmount()); container.remove(); Reflect.deleteProperty(document, 'hidden');
  });
});
