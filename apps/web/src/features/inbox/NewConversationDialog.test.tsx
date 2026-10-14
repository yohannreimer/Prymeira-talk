// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelDto, ConversationDto, ContactDto } from '@prymeira-talk/shared';
import { NewConversationDialog } from './NewConversationDialog';

const api = vi.hoisted(() => ({
  apiGetContacts: vi.fn().mockResolvedValue([]),
  apiCreateContact: vi.fn(),
  apiStartContactConversation: vi.fn()
}));
vi.mock('../../app/api', () => api);

const channel = { id: 'channel-1', workspaceId: 'workspace-1', provider: 'evolution', status: 'connected', providerKey: 'instance-1', displayName: 'Vendas', phoneNumber: null, createdAt: '2026-09-28T12:00:00.000Z', updatedAt: '2026-09-28T12:00:00.000Z' } as ChannelDto;
const contact = { id: 'contact-1', phone: '557991396920', name: null } as ContactDto;
const conversation = { id: 'conversation-1', contactId: contact.id, channelId: channel.id, contactPhone: contact.phone } as ConversationDto;

describe('NewConversationDialog', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    api.apiGetContacts.mockReset().mockResolvedValue([]);
    api.apiCreateContact.mockReset().mockResolvedValue(contact);
    api.apiStartContactConversation.mockReset().mockResolvedValue(conversation);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it('opens a chat from an unsaved phone without sending a message', async () => {
    const onOpened = vi.fn();
    const getToken = async () => 'token';
    await act(async () => root.render(<NewConversationDialog channels={[channel]} getToken={getToken} onClose={() => undefined} onOpened={onOpened} />));
    const input = container.querySelector<HTMLInputElement>('#new-conversation-phone')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '55 79 99139-6920');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(api.apiCreateContact).toHaveBeenCalledWith(getToken, { phone: '557991396920' });
    expect(api.apiStartContactConversation).toHaveBeenCalledWith(getToken, contact.id, { channelId: channel.id });
    expect(onOpened).toHaveBeenCalledWith(conversation);
    expect(container.textContent).toContain('Nada será enviado agora');
  });

  it('requires a valid number and a connected WhatsApp channel', async () => {
    await act(async () => root.render(<NewConversationDialog channels={[]} getToken={async () => 'token'} onClose={() => undefined} onOpened={() => undefined} />));
    expect(container.textContent).toContain('Conecte um canal WhatsApp');
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  });
});
