import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AssistantConversationDto } from '@prymeira-talk/shared';
import { AssistantPanel } from './AssistantPanel';
const data: AssistantConversationDto = { settings: { mode: 'automatic', agentId: 'a' }, status: 'ready', humanControlled: false, suggestion: { id: 's', conversationId: 'c', agentId: 'a', revision: 1, contextKey: 'k', body: 'Qual a cidade de entrega?', instruction: null, createdAt: '2026-09-06T12:00:00Z', warnings: [], actorName: null, finalBody: null, messageId: null, sendStatus: null }, history: [], agentName: 'Pré-atendimento', error: null, currentContextKey: 'k' };
const props = { data, error: null, humanControlled: false, draftExists: false, sending: false, handoffCompleted: false, handoffFeedback: null, handoffBusy: false, onCompleteHandoff: vi.fn(), onReopenHandoff: vi.fn(), onReanalyzeHandoff: vi.fn(), onGenerate: vi.fn(), onSend: vi.fn(), onEdit: vi.fn() };
describe('assistant panel', () => {
  it('shows a private draft with explicit send and edit controls', () => {
    const html = renderToStaticMarkup(<AssistantPanel {...props} />);
    expect(html).toContain('Só você e sua equipe'); expect(html).toContain('Enviar resposta'); expect(html).toContain('Editar no campo'); expect(props.onSend).not.toHaveBeenCalled();
  });
  it('human control overrides even a stale ready server state', () => {
    const html = renderToStaticMarkup(<AssistantPanel {...props} humanControlled />);
    expect(html).toContain('O atendimento está com você'); expect(html).not.toContain('Enviar resposta'); expect(html).not.toContain('assistant-instruction');
  });
  it.each(['stale', 'generating', 'pending', 'sent', 'failed'] as const)('%s cannot send directly', status => expect(renderToStaticMarkup(<AssistantPanel {...props} data={{ ...data, status }} />)).not.toContain('Enviar resposta'));
  it('explains disabled configuration without canned customer replies', () => {
    const html = renderToStaticMarkup(<AssistantPanel {...props} data={{ ...data, settings: { mode: 'disabled', agentId: null } }} />);
    expect(html).toContain('Apoio não ativado'); expect(html).not.toContain('Qual a cidade');
  });
  it('shows the human handoff brief even when suggestions are disabled', () => {
    const html = renderToStaticMarkup(<AssistantPanel {...props} humanControlled data={{ ...data, settings: { mode: 'disabled', agentId: null } }} handoffBrief={{
      status: 'ready', nextAction: 'Verifique se trabalhamos com o material solicitado.',
      summary: 'Ricardo pediu quatro peças de aço 1045 para porcas oxicortadas.',
      contextKey: 'key', updatedAt: '2026-09-22T19:00:00Z', error: null
    }} />);
    expect(html).toContain('Faça agora');
    expect(html).toContain('quatro peças de aço 1045');
    expect(html).not.toContain('Motivo do repasse');
    expect(html).not.toContain('Apoio não ativado');
    expect(html).not.toContain('Enviar resposta');
  });
  it('shows a completed handoff with human control and recovery actions', () => {
    const html = renderToStaticMarkup(<AssistantPanel {...props} humanControlled handoffCompleted handoffFeedback="A resposta gerou um aprimoramento pendente." />);
    expect(html).toContain('Próxima ação concluída');
    expect(html).toContain('Analisar resposta humana');
    expect(html).toContain('Reabrir próxima ação');
    expect(html).toContain('aprimoramento pendente');
  });
  it('escapes customer/provider text and shows media warnings', () => {
    const html = renderToStaticMarkup(<AssistantPanel {...props} data={{ ...data, suggestion: { ...data.suggestion!, body: '<script>unsafe()</script>', warnings: ['PDF não lido.'] } }} />);
    expect(html).not.toContain('<script>'); expect(html).toContain('PDF não lido.');
  });
});
