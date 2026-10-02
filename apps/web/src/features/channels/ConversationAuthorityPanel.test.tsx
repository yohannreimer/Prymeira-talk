// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationAuthorityPanel } from './ConversationAuthorityPanel';

const mocks = vi.hoisted(() => ({ apiListConversationAuthority: vi.fn(), apiResolveConversationAuthority: vi.fn() }));
vi.mock('../../app/api', () => mocks);

const conversation = (id: string, over: Record<string, unknown> = {}) => ({ id, contactName: null, contactPhone: '5547999990002', status: 'open', assignedTo: null, aiControlStatus: 'human_controlled', unreadCount: 0, messageCount: 4, lastMessageAt: null, lastMessagePreview: 'Oi', ...over });
const item = (chatId: string) => ({ chatId, channelId: 'c', address: '5547999990002@s.whatsapp.net', conversations: [conversation(`${chatId}-a`, { contactName: 'Ana' }), conversation(`${chatId}-b`, { contactPhone: '123@lid' })] });

describe('ConversationAuthorityPanel', () => {
  let root: Root; let container: HTMLDivElement;
  const getToken = async () => 'token';
  const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('button')];
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    mocks.apiListConversationAuthority.mockReset(); mocks.apiResolveConversationAuthority.mockReset();
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it('renders nothing when there is nothing to decide', async () => {
    mocks.apiListConversationAuthority.mockResolvedValue([]);
    await act(async () => root.render(<ConversationAuthorityPanel getToken={getToken} />));
    expect(container.innerHTML).toBe('');
  });

  it('lists the competing conversations and says nothing is merged or deleted', async () => {
    mocks.apiListConversationAuthority.mockResolvedValue([item('x')]);
    await act(async () => root.render(<ConversationAuthorityPanel getToken={getToken} />));
    expect(container.textContent).toContain('Conversas duplicadas (1)');
    expect(container.textContent).toContain('Ana');
    expect(container.textContent).toContain('123@lid');
    expect(container.textContent).toContain('nada é apagado');
    expect(container.textContent).toContain('número de telefone');
  });

  it('records the choice and removes only that chat; a refusal keeps it with the reason', async () => {
    mocks.apiListConversationAuthority.mockResolvedValue([item('x'), item('y')]);
    mocks.apiResolveConversationAuthority.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Há um envio sem confirmação'));
    await act(async () => root.render(<ConversationAuthorityPanel getToken={getToken} />));
    await act(async () => buttons()[0]!.click());
    expect(mocks.apiResolveConversationAuthority).toHaveBeenCalledWith(getToken, 'x', 'x-a');
    expect(container.textContent).toContain('Conversas duplicadas (1)');
    await act(async () => buttons()[1]!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('envio sem confirmação');
    expect(container.textContent).toContain('Conversas duplicadas (1)');
  });
});
