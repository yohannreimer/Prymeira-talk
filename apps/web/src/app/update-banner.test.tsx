// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isNewBuild, isStaleChunkError, runningBuild, UpdateBanner } from './update-banner';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('new release notice', () => {
  it('knows the running build and compares it with the published one', () => {
    expect(runningBuild('https://talk.prymeiradigital.com.br/assets/index-AbC123.js')).toBe('assets/index-AbC123.js');
    expect(runningBuild('http://localhost:5176/src/main.tsx')).toBeNull();
    expect(isNewBuild('assets/index-AbC123.js', { build: 'assets/index-XyZ789.js' })).toBe(true);
    expect(isNewBuild('assets/index-AbC123.js', { build: 'assets/index-AbC123.js' })).toBe(false);
    expect(isNewBuild(null, { build: 'assets/index-XyZ789.js' })).toBe(false);
    expect(isNewBuild('assets/index-AbC123.js', null)).toBe(false);
  });
  it('recognizes the error of a script removed by a release', () => {
    expect(isStaleChunkError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/InboxPage-1.js'))).toBe(true);
    expect(isStaleChunkError(new Error('Network down'))).toBe(false);
  });
  it('asks for a reload when the server publishes another build', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ build: 'assets/index-new.js' }))));
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    await act(async () => { root.render(<UpdateBanner entryUrl="https://talk.example/assets/index-old.js" />); });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Atualização feita');
    expect(host.querySelector('button')?.textContent).toContain('Recarregar agora');
    await act(async () => { root.unmount(); }); host.remove();
  });
});
