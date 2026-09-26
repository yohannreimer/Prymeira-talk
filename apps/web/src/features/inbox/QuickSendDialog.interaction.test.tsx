// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelDto, ContactDto } from '@prymeira-talk/shared';
import { QuickSendDialog } from './QuickSendDialog';

const api = vi.hoisted(() => ({
  apiGetLatestInboxQuickSend: vi.fn().mockResolvedValue({ campaignId: null }),
  apiGetContactsPage: vi.fn(),
  apiGetConversations: vi.fn().mockResolvedValue([]),
  apiStartInboxQuickSend: vi.fn().mockResolvedValue({ campaignId: 'campaign-1', recipientsQueued: 11 }),
  apiGetInboxQuickSend: vi.fn().mockResolvedValue({ status: 'sending', total: 11, sent: 0, pending: 11, skipped: 0, failed: 0, uncertain: 0, nextScheduledAt: null }),
  apiCancelInboxQuickSend: vi.fn(), apiResumeInboxQuickSend: vi.fn()
}));
vi.mock('../../app/api', () => api);

const channels: ChannelDto[] = [{ id: 'channel-1', workspaceId: 'workspace-1', provider: 'evolution',
  providerKey: 'instance-1', phoneNumber: null, displayName: 'Vendas', status: 'connected',
  createdAt: '2026-09-26T12:00:00.000Z', updatedAt: '2026-09-26T12:00:00.000Z' }];
const contacts: ContactDto[] = Array.from({ length: 12 }, (_, index) => ({
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  workspaceId: 'workspace-1', name: `Contato ${index + 1}`, phone: `554799999${String(index).padStart(4, '0')}`,
  email: null, company: null, atomicCrmContactId: null, atomicCrmLeadId: null,
  createdAt: '2026-09-26T12:00:00.000Z', updatedAt: '2026-09-26T12:00:00.000Z'
}));

describe('QuickSendDialog review', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    api.apiGetContactsPage.mockResolvedValue({ items: contacts, nextCursor: null, total: contacts.length });
    api.apiStartInboxQuickSend.mockClear();
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  it('lets a seller select more than ten people and queues only after explicit confirmation', async () => {
    const getToken = async () => 'token';
    await act(async () => { root.render(<QuickSendDialog channels={channels} getToken={getToken} onClose={() => undefined} onSent={() => undefined} />); });
    expect(container.textContent).toContain('Todos os contatos');
    expect(container.querySelectorAll('[aria-label="Contatos para envio"] [role="option"]')).toHaveLength(0);
    const openContacts = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Todos os contatos'))!;
    await act(async () => openContacts.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
    expect(container.querySelectorAll('[aria-label="Contatos para envio"] [role="option"]')).toHaveLength(12);
    const options = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Contatos para envio"] [role="option"]')];
    for (const option of options.slice(0, 11)) await act(async () => option.click());
    expect(container.textContent).toContain('11 selecionados');
    await act(async () => container.querySelector<HTMLButtonElement>('.inbox-all-contacts-panel footer button')!.click());
    expect(container.querySelector('.inbox-all-contacts-panel')).toBeNull();
    const message = container.querySelector<HTMLTextAreaElement>('#quick-message')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(message, 'Chapas em aço carbono');
      message.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const review = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Revisar envio'))!;
    await act(async () => review.click());
    expect(api.apiStartInboxQuickSend).not.toHaveBeenCalled();
    const confirm = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Confirmar 11 envios'))!;
    await act(async () => confirm.click());
    expect(api.apiStartInboxQuickSend).toHaveBeenCalledWith(getToken, expect.objectContaining({
      confirmation: true, recipients: expect.arrayContaining([expect.objectContaining({ name: 'Contato 1' })])
    }));
    expect(api.apiStartInboxQuickSend.mock.calls[0]![1].recipients).toHaveLength(11);
  });
});
