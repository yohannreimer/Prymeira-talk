// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelDto, ContactDto, ConversationDto } from '@prymeira-talk/shared';
import { ContactCardDialog, ContactCardMessage } from './ContactCardDialog';

const api = vi.hoisted(() => ({
  apiGetContacts: vi.fn(), apiCreateContact: vi.fn(), apiUpdateContact: vi.fn(),
  apiStartContactConversation: vi.fn()
}));
vi.mock('../../app/api', () => api);

const card = { fullName: 'Nelson Tecol', phoneNumber: '556784432788' };
const channel = { id: 'channel-1', provider: 'evolution', status: 'connected' } as ChannelDto;
const contact = { id: 'contact-1', name: 'Nelson Tecol', phone: '556784432788' } as ContactDto;
const conversation = { id: 'conversation-1', channelId: channel.id } as ConversationDto;

describe('shared contact card', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    api.apiGetContacts.mockReset().mockResolvedValue([]);
    api.apiCreateContact.mockReset().mockResolvedValue(contact);
    api.apiUpdateContact.mockReset().mockResolvedValue(contact);
    api.apiStartContactConversation.mockReset().mockResolvedValue(conversation);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it('opens a contact card and saves its name and phone in Talk', async () => {
    const onSelect = vi.fn();
    await act(async () => root.render(<ContactCardMessage cards={[card]} onSelect={onSelect} />));
    await act(async () => container.querySelector('button')!.click());
    expect(onSelect).toHaveBeenCalledWith(card);
    await act(async () => root.render(<ContactCardDialog card={card} channels={[channel]} getToken={async () => 'token'} onClose={() => undefined} onOpened={() => undefined} />));
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Salvar contato')!.click());
    expect(api.apiCreateContact).toHaveBeenCalledWith(expect.any(Function), { phone: card.phoneNumber, name: card.fullName });
    expect(container.textContent).toContain('Contato salvo no Talk.');
    expect(api.apiStartContactConversation).not.toHaveBeenCalled();
  });

  it('opens a conversation without sending a message', async () => {
    const onOpened = vi.fn();
    await act(async () => root.render(<ContactCardDialog card={card} channels={[channel]} getToken={async () => 'token'} onClose={() => undefined} onOpened={onOpened} />));
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Abrir conversa'))!.click());
    expect(api.apiStartContactConversation).toHaveBeenCalledWith(expect.any(Function), contact.id, { channelId: channel.id });
    expect(onOpened).toHaveBeenCalledWith(conversation);
  });
});
