// @vitest-environment jsdom
import { act, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { ModuleErrorBoundary } from './ModuleErrorBoundary';
describe('lazy deployment recovery', () => {
  it('shows a usable reload action when an old hashed module chunk cannot load', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const LazyModule = lazy(async () => { throw new Error('Failed to fetch dynamically imported module'); });
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
    await act(async () => root.render(<ModuleErrorBoundary><Suspense fallback="Loading"><LazyModule /></Suspense></ModuleErrorBoundary>));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Recarregue');
    const button = container.querySelector<HTMLButtonElement>('button')!; expect(button.textContent).toBe('Recarregar aplicativo'); expect(button.disabled).toBe(false);
    await act(async () => root.unmount()); container.remove(); error.mockRestore();
  });
});
