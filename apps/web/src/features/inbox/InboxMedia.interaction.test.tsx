// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxMedia } from './InboxMedia';
import type { MessageDto } from '@prymeira-talk/shared';
import { apiGetAudioTranscription } from '../../app/api';

vi.mock('../../app/api', () => ({
  apiGetAudioTranscription: vi.fn(),
  apiGetInboxMedia: vi.fn(), apiGetVideoPoster: vi.fn(),
  apiGetPdfPreview: vi.fn()
}));

describe('audio transcription control', () => {
  const message: MessageDto = {
    id: 'audio-1', conversationId: 'conversation-1', workspaceId: 'workspace-1',
    providerMessageId: null, direction: 'inbound', type: 'audio', body: 'Áudio recebido',
    mediaUrl: 'data:audio/ogg;base64,YQ==', status: 'delivered', sentByUserId: null,
    createdAt: '2026-09-28T16:54:00Z'
  };
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
    vi.clearAllMocks();
  });

  it('requests a missing transcript when opened and lets the user close it', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.mocked(apiGetAudioTranscription).mockResolvedValue({ text: 'Pedido de orçamento' });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root.render(<InboxMedia message={message} getToken={async () => 'token'} />));

    const toggle = container.querySelector<HTMLButtonElement>('.talk-audio-transcript button')!;
    expect(toggle.textContent).toBe('Ver transcrição');
    await act(async () => toggle.click());
    expect(apiGetAudioTranscription).toHaveBeenCalledWith('conversation-1', 'audio-1', expect.any(Function), expect.any(AbortSignal));
    expect(container.textContent).toContain('Pedido de orçamento');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    await act(async () => toggle.click());
    expect(toggle.textContent).toBe('Ver transcrição');
    expect(container.textContent).not.toContain('Pedido de orçamento');
  });
});
