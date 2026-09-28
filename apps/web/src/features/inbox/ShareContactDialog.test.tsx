// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactDto, ConversationDto } from '@prymeira-talk/shared';
import { ShareContactDialog } from './ShareContactDialog';

const api = vi.hoisted(() => ({
  apiGetContacts: vi.fn().mockResolvedValue([]),
  apiCreateContact: vi.fn(),
  apiStartContactConversation: vi.fn(),
  apiGetConversationMessages: vi.fn(),
  apiCreateConversationMessage: vi.fn()
}));
const images = vi.hoisted(() => ({ createConversationContextImages: vi.fn() }));
vi.mock('../../app/api', () => api);
vi.mock('./conversation-context-image', () => images);

const source = { id: 'source-1', channelId: 'channel-1', channelName: 'Vendas', contactId: 'contact-1', contactName: 'Cliente', contactPhone: '5547999991111' } as ConversationDto;
const recipient = { id: 'contact-2', name: null, phone: '557991396920' } as ContactDto;
const image = { fileName: 'historico-conversa-1.png', mediaUrl: 'data:image/png;base64,AAAA', mimetype: 'image/png' };

describe('ShareContactDialog context forwarding', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    api.apiGetContacts.mockReset().mockResolvedValue([]);
    api.apiCreateContact.mockReset().mockResolvedValue(recipient);
    api.apiStartContactConversation.mockReset().mockResolvedValue({ id: 'target-1' });
    api.apiGetConversationMessages.mockReset().mockResolvedValue([{ id: 'message-1' }]);
    api.apiCreateConversationMessage.mockReset().mockResolvedValue({ status: 'sent' });
    images.createConversationContextImages.mockReset().mockReturnValue([image]);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  async function chooseRecipient() {
    const input = container.querySelector<HTMLInputElement>('#share-recipient-search')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '55 79 99139-6920');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const useNumber = [...container.querySelectorAll<HTMLButtonElement>('.inbox-recipient-results button')].find((button) => button.textContent?.includes('Usar'))!;
    await act(async () => useNumber.click());
  }

  it('sends the contact card before the context image from the source chat', async () => {
    const onSent = vi.fn();
    await act(async () => root.render(<ShareContactDialog source={source} getToken={async () => 'token'} onClose={() => undefined} onSent={onSent} />));
    await chooseRecipient();
    await act(async () => container.querySelector<HTMLButtonElement>('footer .primary-button')!.click());
    expect(api.apiGetConversationMessages).toHaveBeenCalledWith(source.id, expect.any(Function));
    expect(images.createConversationContextImages).toHaveBeenCalledWith([{ id: 'message-1' }], source);
    expect(api.apiCreateConversationMessage).toHaveBeenNthCalledWith(1, 'target-1', { contactCard: { sourceConversationId: source.id } }, expect.any(Function));
    expect(api.apiCreateConversationMessage).toHaveBeenNthCalledWith(2, 'target-1', expect.objectContaining({ attachment: image }), expect.any(Function));
    expect(onSent).toHaveBeenCalledWith(recipient.phone, 1);
  });

  it('retries only the context image after the card was confirmed', async () => {
    api.apiCreateConversationMessage.mockResolvedValueOnce({ status: 'sent' }).mockRejectedValueOnce(new Error('Falha na imagem')).mockResolvedValueOnce({ status: 'sent' });
    const onSent = vi.fn();
    await act(async () => root.render(<ShareContactDialog source={source} getToken={async () => 'token'} onClose={() => undefined} onSent={onSent} />));
    await chooseRecipient();
    await act(async () => container.querySelector<HTMLButtonElement>('footer .primary-button')!.click());
    expect(container.textContent).toContain('Cartão enviado');
    expect(container.textContent).toContain('Falha na imagem');
    await act(async () => container.querySelector<HTMLButtonElement>('footer .primary-button')!.click());
    expect(api.apiCreateConversationMessage).toHaveBeenCalledTimes(3);
    expect(api.apiCreateConversationMessage.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ attachment: image }));
    expect(api.apiGetConversationMessages).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalledWith(recipient.phone, 1);
  });
});
