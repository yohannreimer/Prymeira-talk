// @vitest-environment jsdom
import type { ConversationFollowupDto, MessageDto } from '@prymeira-talk/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ messages: vi.fn() }));
vi.mock('../../app/api', async original => ({ ...await original<typeof import('../../app/api')>(), apiGetConversationMessages: mocks.messages }));
vi.mock('../inbox/InboxMedia', () => ({ InboxMedia: ({ message }: { message: MessageDto }) => <div>Áudio disponível: {message.id}</div>, mediaCaption: () => null }));
import { FollowupReview } from './FollowupReview';

const first: ConversationFollowupDto = {
  id: 'followup-a', workspaceId: 'workspace', conversationId: 'conversation-a', agentId: 'agent', kind: 'human_commercial', status: 'review', stepIndex: 1,
  scheduledAt: '2026-10-15T12:00:00.000Z', draftBody: 'Conseguiu avaliar o orçamento?', contact: { name: 'Cliente A', phone: '551111' }, channel: { displayName: 'Geral Villefer' },
  anchorMessage: { id: 'anchor-a', body: 'Orçamento enviado.', type: 'text', createdAt: '2026-10-14T12:00:00.000Z' },
  purpose: 'proposal_checkin', reasonCode: null, analysis: null, createdAt: '2026-10-14T12:00:00.000Z', updatedAt: '2026-10-15T11:00:00.000Z'
};
const second = { ...first, id: 'followup-b', conversationId: 'conversation-b', contact: { name: 'Cliente B', phone: '552222' } };
const third = { ...first, id: 'followup-c', conversationId: 'conversation-c', contact: { name: 'Cliente C', phone: '553333' } };
const message: MessageDto = { id: 'message', workspaceId: 'workspace', conversationId: first.conversationId, providerMessageId: null, direction: 'inbound', type: 'text', body: 'Quero chapa xadrez para Joinville.', mediaUrl: null, status: 'read', sentByUserId: null, createdAt: '2026-10-14T12:00:00.000Z' };

describe('FollowupReview', () => {
  let host: HTMLDivElement, root: Root;
  const props = () => ({ followups: [first, second, third], getToken: vi.fn(async () => 'token'), busyId: null as string | null, errors: {}, contextRevisions: {}, onSend: vi.fn(), onPostpone: vi.fn(), onCancel: vi.fn(), onNoFollowup: vi.fn(), onOpenConversation: vi.fn() });
  let input: ReturnType<typeof props>;
  const render = async () => { await act(async () => root.render(<FollowupReview {...input} />)); };
  const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? [...host.querySelectorAll('button')].find(b => b.textContent === label)!;
  const click = async (label: string) => { await act(async () => button(label).click()); };
  const draft = () => host.querySelector<HTMLTextAreaElement>('textarea')!;
  const edit = async (text: string) => { await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(draft(), text); draft().dispatchEvent(new Event('input', { bubbles: true })); }); };
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    input = props(); mocks.messages.mockReset().mockResolvedValue([message]);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

  it('reads the conversation and sends only the edited draft with its version', async () => {
    await render();
    expect(host.querySelector('.fr-timeline')?.textContent).toContain(message.body);
    expect(mocks.messages).toHaveBeenCalledWith(first.conversationId, input.getToken, expect.any(AbortSignal));
    expect(input.onSend).not.toHaveBeenCalled();
    await edit('As condições do orçamento atendem?');
    await click('Próxima conversa'); await click('Conversa anterior');
    expect(draft().value).toBe('As condições do orçamento atendem?');
    await click('Enviar follow-up');
    expect(input.onSend).toHaveBeenCalledWith(first, 'As condições do orçamento atendem?', first.updatedAt);
  });

  it('invalidates edits immediately on a message revision and reloads before enabling send', async () => {
    await render(); await edit('Edição antiga');
    let complete!: (value: MessageDto[]) => void;
    mocks.messages.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    input.contextRevisions = { [first.conversationId]: 1 }; await render();
    expect(draft().value).toBe(first.draftBody);
    expect(button('Enviar follow-up').disabled).toBe(true);
    expect(host.textContent).toContain('O contexto mudou');
    await act(async () => complete([{ ...message, body: 'Cliente respondeu agora.' }]));
    expect(button('Enviar follow-up').disabled).toBe(false);
    expect(host.querySelector('.fr-timeline')?.textContent).toContain('Cliente respondeu agora.');
  });

  it('ignores a late history response from the previous conversation', async () => {
    let completeA!: (value: MessageDto[]) => void;
    mocks.messages.mockReturnValueOnce(new Promise(resolve => { completeA = resolve; })).mockResolvedValueOnce([{ ...message, conversationId: second.conversationId, body: 'Histórico B' }]);
    await render(); expect(button('Enviar follow-up').disabled).toBe(true);
    await click('Próxima conversa');
    await act(async () => completeA([{ ...message, body: 'Histórico A atrasado' }]));
    expect(host.querySelector('.fr-timeline')?.textContent).toContain('Histórico B');
    expect(host.querySelector('.fr-timeline')?.textContent).not.toContain('Histórico A atrasado');
  });

  it('keeps send disabled after history failure and allows an explicit retry', async () => {
    mocks.messages.mockRejectedValueOnce(new Error('offline'));
    await render(); expect(button('Enviar follow-up').disabled).toBe(true);
    expect(host.textContent).toContain('Não foi possível carregar a conversa');
    await click('Tentar novamente'); expect(button('Enviar follow-up').disabled).toBe(false);
    expect(input.onSend).not.toHaveBeenCalled();
  });

  it('opens the next item at the removed item position and keeps the selection on refresh', async () => {
    await render(); await click('Próxima conversa');
    input.followups = [first, second, { ...third, draftBody: 'Atualizado' }]; await render();
    expect(host.querySelector('h2')?.textContent).toBe('Cliente B');
    await click('Cancelar follow-up'); expect(input.onCancel).not.toHaveBeenCalled();
    await click('Confirmar cancelamento'); expect(input.onCancel).toHaveBeenCalledWith(second);
    input.followups = [first, third]; await render();
    expect(host.querySelector('h2')?.textContent).toBe('Cliente C');
    expect(input.onSend).not.toHaveBeenCalled();
  });

  it('keeps errors on the selected item and blocks navigation while sending', async () => {
    input.busyId = first.id; input.errors = { [first.id]: 'Falha no envio; revise antes de tentar.' };
    await render(); expect(host.textContent).toContain('Falha no envio');
    expect(button('Próxima conversa').disabled).toBe(true);
    expect(button('Enviar follow-up').disabled).toBe(true);
    expect(draft().disabled).toBe(true);
  });

  it('reveals older messages in batches without mixing reactions or reset history', async () => {
    mocks.messages.mockResolvedValue([
      ...Array.from({ length: 45 }, (_, i) => ({ ...message, id: `msg-${i}`, body: `Mensagem número ${i}` })),
      { ...message, id: 'hidden', body: 'Histórico anterior ao reset', hiddenByReset: true },
      { ...message, id: 'reaction', body: 'Reação isolada', reaction: { targetWhatsappId: 'abc', emoji: '👍' } },
      { ...message, id: 'audio', body: 'Transcrição', type: 'audio' }
    ]);
    await render();
    expect(host.querySelectorAll('.fr-message')).toHaveLength(20);
    expect(host.textContent).toContain('Áudio disponível: audio');
    expect(host.textContent).not.toContain('Histórico anterior ao reset');
    expect(host.textContent).not.toContain('Reação isolada');
    await click('Carregar mensagens anteriores');
    expect(host.querySelectorAll('.fr-message')).toHaveLength(40);
  });

  it('searches the queue and selects a conversation without taking an action', async () => {
    await render(); await click('Ver todos');
    const search = host.querySelector<HTMLInputElement>('input')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'Cliente C'); search.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(host.querySelectorAll('.fr-queue-item')).toHaveLength(1);
    await act(async () => host.querySelector<HTMLButtonElement>('.fr-queue-item')!.click());
    expect(host.querySelector('h2')?.textContent).toBe('Cliente C');
    expect(input.onSend).not.toHaveBeenCalled(); expect(input.onCancel).not.toHaveBeenCalled();
  });

  it('requires a distinct confirmation to stop following the conversation', async () => {
    await render(); await click('Mais opções'); await click('Não acompanhar esta conversa');
    expect(input.onNoFollowup).not.toHaveBeenCalled();
    await click('Confirmar não acompanhar'); expect(input.onNoFollowup).toHaveBeenCalledWith(first);
    expect(input.onCancel).not.toHaveBeenCalled();
  });

  it('ignores the second click of a double click instead of sending the next item', async () => {
    await render();
    await act(async () => button('Enviar follow-up').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })));
    expect(input.onSend).not.toHaveBeenCalled();
  });
});
