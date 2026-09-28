// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RichDraft } from './RichDraft';

describe('RichDraft clipboard paste', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onChange = vi.fn();
  const onPasteImage = vi.fn();

  beforeEach(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onChange.mockClear();
    onPasteImage.mockClear();
    await act(async () => root.render(
      <RichDraft value="" disabled={false} onChange={onChange} onFormatChange={() => {}} onPasteImage={onPasteImage} />
    ));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function paste(clipboardData: Partial<DataTransfer>) {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: clipboardData });
    const editor = container.querySelector<HTMLElement>('[role="textbox"]')!;
    await act(async () => { editor.focus(); editor.dispatchEvent(event); });
    return event;
  }

  it('stages a screenshot once, even when the clipboard also contains text', async () => {
    const image = new File(['screenshot'], 'captura.png', { type: 'image/png' });
    const event = await paste({
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }] as unknown as DataTransferItemList,
      files: [image] as unknown as FileList,
      getData: () => 'Texto da área de transferência'
    });

    expect(event.defaultPrevented).toBe(true);
    expect(onPasteImage).toHaveBeenCalledExactlyOnceWith(image);
    expect(container.querySelector('[role="textbox"]')?.textContent).toBe('');
  });

  it('keeps plain text paste in the message editor', async () => {
    await paste({ items: [] as unknown as DataTransferItemList, files: [] as unknown as FileList, getData: () => 'Olá' });

    expect(onPasteImage).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith('Olá');
  });

  it('accepts image files when clipboard items are unavailable', async () => {
    const image = new File(['screenshot'], '', { type: 'image/png' });
    await paste({ files: [image] as unknown as FileList, getData: () => '' });

    expect(onPasteImage).toHaveBeenCalledTimes(1);
    expect(onPasteImage.mock.calls[0][0]).toMatchObject({ name: 'captura-de-tela.png', type: 'image/png', size: image.size });
  });
});
