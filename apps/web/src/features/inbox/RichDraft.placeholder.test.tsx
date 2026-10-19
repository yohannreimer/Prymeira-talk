// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { RichDraft } from './RichDraft';

describe('composer placeholder', () => {
  it('shows only when nothing is written, never behind text with a line break', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    const draw = (value: string) => act(async () => root.render(<RichDraft value={value} disabled={false} onChange={() => {}} onFormatChange={() => {}} />));
    await draw('');
    expect(container.querySelector('.composer-rich-shell')?.classList.contains('is-empty')).toBe(true);
    await draw('de foder\nnee');
    expect(container.querySelector('.composer-rich-shell')?.classList.contains('is-empty')).toBe(false);
    await act(async () => root.unmount()); container.remove();
  });
});
