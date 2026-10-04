// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, it, expect, vi, type Mock } from 'vitest';
import { VoiceRecorder, recordingMime } from './VoiceRecorder';
import { ApiRequestError } from '../../app/api';
vi.mock('./media-data-url', () => ({ mediaDataUrl: async () => 'data:audio/webm;base64,YQ==' }));
class Recording {
  static isTypeSupported() { return true; }
  static mime = 'audio/webm';
  state = 'inactive'; mimeType = Recording.mime;
  ondataavailable?: (event: { data: Blob }) => void; onstop?: () => void;
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['voice']) }); queueMicrotask(() => this.onstop?.()); }
}
describe('recording requires explicit send', () => {
  let root: Root; let container: HTMLDivElement;
  let stop: ReturnType<typeof vi.fn>; let getUserMedia: ReturnType<typeof vi.fn>; let onSend: Mock<(file: File) => Promise<void>>;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    stop = vi.fn(); getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }); onSend = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } }); vi.stubGlobal('MediaRecorder', Recording);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function render() { await act(async () => root.render(<VoiceRecorder disabled={false} onSend={onSend} />)); }
  async function click(label: string) { const button = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!; expect(button).not.toBeNull(); await act(async () => button.click()); }
  it('does not request permission on mount, releases capture on stop, and only sends after approval', async () => {
    await render(); expect(getUserMedia).not.toHaveBeenCalled();
    await click('Gravar áudio'); expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    await click('Parar e ouvir antes'); expect(stop).toHaveBeenCalled(); expect(onSend).not.toHaveBeenCalled();
    expect(container.querySelector('audio')).not.toBeNull();
    await click('Enviar áudio'); expect(onSend).toHaveBeenCalledTimes(1); expect(container.querySelector('audio')).toBeNull();
  });
  it('discards instead of sending and releases an unmounted recording', async () => {
    await render(); await click('Gravar áudio'); await click('Descartar gravação'); expect(stop).toHaveBeenCalled(); expect(onSend).not.toHaveBeenCalled();
    await click('Gravar áudio'); await act(async () => root.render(<p>Outra conversa</p>)); expect(stop.mock.calls.length).toBeGreaterThanOrEqual(2); expect(onSend).not.toHaveBeenCalled();
  });
  it('cancels a late permission response after conversation change', async () => {
    let resolve!: (value: unknown) => void; getUserMedia.mockReturnValue(new Promise(r => { resolve = r; }));
    await render(); await click('Gravar áudio'); await act(async () => root.render(<p>Outra conversa</p>));
    await act(async () => resolve({ getTracks: () => [{ stop }] })); expect(stop).toHaveBeenCalledTimes(1); expect(onSend).not.toHaveBeenCalled();
  });
  it('shows a permission denial without sending', async () => {
    getUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    await render(); await click('Gravar áudio'); expect(container.textContent).toContain('Permita o microfone'); expect(onSend).not.toHaveBeenCalled();
  });
  it('retains preview on uncertain failure and never retries automatically', async () => {
    onSend.mockRejectedValue(new Error('network')); await render(); await click('Gravar áudio'); await click('Parar e ouvir antes'); await click('Enviar áudio');
    expect(container.textContent).toContain('Confira a conversa'); expect(container.querySelector('audio')).not.toBeNull(); expect(onSend).toHaveBeenCalledTimes(1);
  });
  it('sends straight from the recording, like WhatsApp, as a bare audio type even when Safari adds codecs', async () => {
    Recording.mime = 'audio/webm; codecs=opus';
    await render(); await click('Gravar áudio'); await click('Enviar áudio'); await act(async () => { await Promise.resolve(); });
    Recording.mime = 'audio/webm';
    expect(stop).toHaveBeenCalled(); expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0].type).toBe('audio/webm');
    expect(container.querySelector('audio')).toBeNull(); expect(container.querySelector('[aria-label="Gravar áudio"]')).not.toBeNull();
  });
  it('says why a refused recording was refused, keeping it to try again', async () => {
    onSend.mockRejectedValue(new ApiRequestError('Áudio inválido ou maior que 8 MB.', undefined, 'INVALID_VOICE_RECORDING'));
    await render(); await click('Gravar áudio'); await click('Enviar áudio'); await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('Áudio inválido'); expect(container.querySelector('audio')).not.toBeNull();
  });
  it('chooses an actually supported recorder format', () => {
    expect(recordingMime(mime => mime === 'audio/mp4')).toBe('audio/mp4'); expect(recordingMime(() => false)).toBeUndefined();
  });
});
