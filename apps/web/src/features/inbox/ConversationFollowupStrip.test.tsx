// @vitest-environment jsdom
import type { ConversationFollowupDto } from '@prymeira-talk/shared';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiGetConversationFollowup, apiMarkFollowupDone, apiMarkFollowupNoFollowup } from '../../app/api';
import { ConversationFollowupStrip, useConversationFollowup } from './ConversationFollowupStrip';

vi.mock('../../app/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../app/api')>(),
  apiGetConversationFollowup: vi.fn(),
  apiMarkFollowupDone: vi.fn(),
  apiMarkFollowupNoFollowup: vi.fn()
}));

const token = async () => 'token';
const review: ConversationFollowupDto = {
  id: 'followup-1', workspaceId: 'workspace-1', conversationId: 'conversation-1', agentId: 'agent-1',
  kind: 'human_commercial', status: 'review', stepIndex: 1, scheduledAt: '2026-09-22T15:00:00.000Z',
  draftBody: 'Oi, Ana! Conseguiu avaliar a proposta?',
  contact: { name: 'Ana Souza', phone: null }, channel: { displayName: null },
  anchorMessage: { id: null, body: null, type: null, createdAt: null },
  purpose: null, reasonCode: null,
  analysis: { situation: 'waiting_customer', pendingItem: 'Retorno sobre a proposta', nextStep: null,
    timingNote: null, rationale: 'A Ana ficou de avaliar.', confidence: 0.9 },
  createdAt: '2026-09-22T12:00:00.000Z', updatedAt: '2026-09-22T14:00:00.000Z'
};
const reminder: ConversationFollowupDto = {
  ...review, id: 'followup-2', kind: 'seller_reminder', draftBody: null,
  analysis: { ...review.analysis!, situation: 'waiting_company', pendingItem: 'Enviar o orçamento do portão' }
};
const closed = (followup: ConversationFollowupDto): Extract<ConversationFollowupDto, { status: 'cancelled' }> => ({
  ...followup, status: 'cancelled', reason: 'seller_done', cancelledAt: '2026-09-22T15:00:00.000Z',
  cancelledByUserId: 'user-1', updatedAt: '2026-09-22T15:00:00.000Z'
});

let apply: (followup: ConversationFollowupDto) => void = () => undefined;
function Probe({ conversationId, onUseMessage = vi.fn() }: { conversationId: string; onUseMessage?: (body: string) => void }) {
  const state = useConversationFollowup(conversationId, token);
  apply = state.apply;
  return <ConversationFollowupStrip followup={state.followup} getToken={token} onUseMessage={onUseMessage} onUpdated={state.apply} />;
}

function buttonByText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes(text)) ?? null;
}

describe('conversation follow-up strip', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.clearAllMocks(); });

  it('offers the follow-up draft to the composer and dismisses with "Não precisa"', async () => {
    vi.mocked(apiGetConversationFollowup).mockResolvedValue(review);
    vi.mocked(apiMarkFollowupNoFollowup).mockResolvedValue({ ...closed(review), reason: 'no_followup' });
    const onUseMessage = vi.fn();
    await act(async () => root.render(<Probe conversationId="conversation-1" onUseMessage={onUseMessage} />));

    expect(container.textContent).toContain('Follow-up: Retorno sobre a proposta');
    await act(async () => buttonByText(container, 'Usar mensagem')?.click());
    expect(onUseMessage).toHaveBeenCalledWith(review.draftBody);

    await act(async () => buttonByText(container, 'Não precisa')?.click());
    expect(apiMarkFollowupNoFollowup).toHaveBeenCalledWith(token, review.id, review.updatedAt);
    expect(container.textContent).toBe('');
  });

  it('says when a scheduled suggestion is ready, without offering to send it', async () => {
    vi.mocked(apiGetConversationFollowup).mockResolvedValue({ ...review, status: 'scheduled' });
    await act(async () => root.render(<Probe conversationId="conversation-1" />));

    expect(container.textContent).toMatch(/Follow-up: Retorno sobre a proposta\. Sugestão pronta para 22 de set.* às 12:00/);
    expect(buttonByText(container, 'Usar mensagem')).toBeNull();
    expect(buttonByText(container, 'Não precisa')).not.toBeNull();
  });

  it('shows a seller reminder in amber with "Já fiz" only', async () => {
    vi.mocked(apiGetConversationFollowup).mockResolvedValue(reminder);
    vi.mocked(apiMarkFollowupDone).mockResolvedValue(closed(reminder));
    await act(async () => root.render(<Probe conversationId="conversation-1" />));

    expect(container.querySelector('.conversation-followup-strip.is-reminder')).not.toBeNull();
    expect(container.textContent).toContain('Lembrete: Enviar o orçamento do portão');
    expect(buttonByText(container, 'Usar mensagem')).toBeNull();
    expect(buttonByText(container, 'Não precisa')).toBeNull();

    await act(async () => buttonByText(container, 'Já fiz')?.click());
    expect(apiMarkFollowupDone).toHaveBeenCalledWith(token, reminder.id, reminder.updatedAt);
    expect(container.textContent).toBe('');
  });

  it('stays hidden without an active follow-up or without the AI reading', async () => {
    vi.mocked(apiGetConversationFollowup).mockResolvedValueOnce(null).mockResolvedValueOnce({ ...review, analysis: null });
    await act(async () => root.render(<Probe conversationId="conversation-1" />));
    expect(container.textContent).toBe('');
    await act(async () => root.render(<Probe conversationId="conversation-2" />));
    expect(container.textContent).toBe('');
  });

  it('follows realtime updates for the open conversation only', async () => {
    vi.mocked(apiGetConversationFollowup).mockResolvedValue(null);
    await act(async () => root.render(<Probe conversationId="conversation-1" />));

    await act(async () => apply({ ...review, conversationId: 'conversation-9' }));
    expect(container.textContent).toBe('');
    await act(async () => apply(review));
    expect(container.textContent).toContain('Follow-up: Retorno sobre a proposta');
    await act(async () => apply(closed(review)));
    expect(container.textContent).toBe('');
  });

  it('does not carry a follow-up across conversations', async () => {
    vi.mocked(apiGetConversationFollowup).mockResolvedValueOnce(review)
      .mockReturnValueOnce(new Promise<ConversationFollowupDto | null>(() => undefined));
    function Switcher() {
      const [id, setId] = useState('conversation-1');
      return <><button type="button" onClick={() => setId('conversation-2')}>trocar</button><Probe conversationId={id} /></>;
    }
    await act(async () => root.render(<Switcher />));
    expect(container.textContent).toContain('Retorno sobre a proposta');
    await act(async () => buttonByText(container, 'trocar')?.click());
    expect(container.textContent).not.toContain('Retorno sobre a proposta');
  });
});
