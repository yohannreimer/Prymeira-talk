// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactDto } from '@prymeira-talk/shared';
import { BroadcastListDialog } from './BroadcastListDialog';

const mocks = vi.hoisted(() => ({
  apiGetBroadcastLists: vi.fn(), apiGetBroadcastList: vi.fn(), apiCreateBroadcastList: vi.fn(),
  apiRenameBroadcastList: vi.fn(), apiGetContactsPage: vi.fn(), apiAddBroadcastListMembers: vi.fn(),
  apiRemoveBroadcastListMember: vi.fn(), apiGetContacts: vi.fn(), apiCreateContact: vi.fn(), apiUpdateContact: vi.fn()
}));
vi.mock('../../app/api', () => mocks);
vi.mock('../inbox/ContactAvatar', () => ({
  ContactPhotoProvider: ({ children }: { children: ReactNode }) => children,
  ContactAvatar: ({ name }: { name: string }) => <span>{name.slice(0, 1)}</span>
}));

const listId = '00000000-0000-4000-8000-000000000201';
const contact = { id: '00000000-0000-4000-8000-000000000202', name: 'Nelson Tecol', phone: '556784432788' } as ContactDto;

describe('broadcast list manager', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    Object.values(mocks).forEach((mock) => mock.mockReset());
    let list: { id: string; name: string; memberCount: number; createdAt: string; updatedAt: string } | null = null;
    let members: ContactDto[] = [];
    mocks.apiGetBroadcastLists.mockImplementation(async () => list ? [list] : []);
    mocks.apiCreateBroadcastList.mockImplementation(async (_getToken, name) => {
      list = { id: listId, name, memberCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      return list;
    });
    mocks.apiGetBroadcastList.mockImplementation(async () => ({ ...list, memberCount: members.length, contacts: members }));
    mocks.apiGetContactsPage.mockResolvedValue({ items: [contact], nextCursor: null, total: 1 });
    mocks.apiAddBroadcastListMembers.mockImplementation(async () => { members = [contact]; if (list) list.memberCount = members.length; });
    mocks.apiRemoveBroadcastListMember.mockImplementation(async () => { members = []; if (list) list.memberCount = 0; });
    mocks.apiGetContacts.mockResolvedValue([]);
    mocks.apiCreateContact.mockResolvedValue(contact);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it('creates a reusable list, adds a contact, and selects it for a campaign', async () => {
    const onSelected = vi.fn();
    await act(async () => root.render(<BroadcastListDialog initialListId={null} getToken={async () => 'token'} onClose={() => undefined} onSelected={onSelected} />));
    const name = document.querySelector<HTMLInputElement>('#broadcast-list-new-name')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Clientes Villefer'); name.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Criar lista"]')!.click());
    expect(mocks.apiCreateBroadcastList).toHaveBeenCalledWith(expect.any(Function), 'Clientes Villefer');
    await act(async () => document.querySelector<HTMLInputElement>('[aria-label="Adicionar Nelson Tecol"]')!.click());
    expect(mocks.apiAddBroadcastListMembers).toHaveBeenCalledWith(expect.any(Function), listId, [contact.id]);
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Usar esta lista'))!.click());
    expect(onSelected).toHaveBeenCalledWith(expect.objectContaining({ id: listId, memberCount: 1 }));
  });
});
