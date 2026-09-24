import { useRef, useState } from 'react';
import { Check, LockKeyhole, MessageSquareText, Pencil, RefreshCw, Send, UserRound } from 'lucide-react';
import type { AssistantConversationDto, AssistantSuggestionDto } from '@prymeira-talk/shared';
import { HandoffBrief } from './HandoffBrief';
import type { HandoffBriefDto } from '../../../../../packages/shared/src/assistant';

type Props = {
  data: AssistantConversationDto | null; error: string | null; humanControlled: boolean;
  draftExists: boolean; sending: boolean;
  handoffBrief?: HandoffBriefDto | null;
  handoffCompleted: boolean; handoffFeedback: string | null; handoffBusy: boolean;
  onCompleteHandoff: () => void; onReopenHandoff: () => void; onReanalyzeHandoff: () => void;
  onGenerate: (instruction?: string) => Promise<void>;
  onSend: (suggestion: AssistantSuggestionDto) => Promise<void>;
  onEdit: (suggestion: AssistantSuggestionDto, confirmed: boolean) => void;
};
export function AssistantPanel({ data, error, humanControlled, draftExists, sending, handoffBrief, handoffCompleted, handoffFeedback, handoffBusy, onCompleteHandoff, onReopenHandoff, onReanalyzeHandoff, onGenerate, onSend, onEdit }: Props) {
  const [instruction, setInstruction] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [replace, setReplace] = useState(false);
  const busy = useRef(false);
  const suggestion = data?.suggestion;
  const paused = (humanControlled || data?.humanControlled) && !data?.humanSupport;
  const handoffPending = Boolean(handoffBrief && !handoffCompleted);
  const awaitingCustomer = Boolean(data?.awaitingCustomer && !handoffPending);
  const generating = requesting || data?.status === 'generating' || data?.status === 'pending';
  const ready = data?.status === 'ready' && !paused && !generating && !awaitingCustomer;
  async function generate(text?: string) {
    if (busy.current) return;
    busy.current = true; setRequesting(true); setLocalError(null);
    try { await onGenerate(text); setInstruction(''); } catch (e) { setLocalError(e instanceof Error ? e.message : 'Não foi possível gerar.'); }
    finally { busy.current = false; setRequesting(false); }
  }
  async function send() {
    if (!suggestion || busy.current) return;
    if (draftExists) { setLocalError('Há um texto no campo de mensagem. Envie ou apague esse rascunho antes.'); return; }
    busy.current = true; setLocalError(null);
    try { await onSend(suggestion); } catch (e) { setLocalError(e instanceof Error ? e.message : 'Confira a conversa antes de tentar novamente.'); }
    finally { busy.current = false; }
  }
  return <div className="assistant-panel">
    <div className="assistant-private"><LockKeyhole size={14} aria-hidden="true" /> Só você e sua equipe veem este apoio</div>
    {(localError || (!handoffPending && !awaitingCustomer && error)) ? <p className="assistant-alert" role="alert">{localError ?? error}</p> : null}
    {handoffPending ? <HandoffBrief brief={handoffBrief!} busy={handoffBusy} onComplete={onCompleteHandoff} /> : null}
    {!data ? !handoffPending ? <div className="assistant-empty">{error ? 'Tente abrir novamente o apoio.' : 'Selecione uma conversa para acompanhar as sugestões.'}</div> : null : data.settings.mode === 'disabled' ? !handoffPending ? <div className="assistant-empty"><MessageSquareText size={24} /><h3>Apoio não ativado</h3><p>Um gestor pode escolher o agente e ativar as sugestões em Canais.</p></div> : null : handoffPending ? null : <>
      <div className="assistant-state" role="status"><span className={`assistant-status-dot${paused ? ' is-paused' : ''}`} />{paused ? 'Humano no controle' : awaitingCustomer ? 'Aguardando nova mensagem do cliente' : generating ? 'Preparando sugestão…' : ready ? 'Pronta para revisão' : data.status === 'sent' ? 'Envio registrado' : data.status === 'failed' ? 'Não foi possível gerar' : 'Aguardando revisão'}<small>{data.agentName}</small></div>
      {paused ? <div className="assistant-empty"><UserRound size={24} /><h3>O atendimento está com você</h3><p>A IA não gera sugestões enquanto o humano está no controle. Você pode continuar pelo campo de mensagem.</p></div> : null}
      {!paused && !awaitingCustomer && suggestion ? <section className={`assistant-reply${!ready ? ' is-outdated' : ''}`} aria-label="Resposta sugerida"><span className="assistant-eyebrow">Sugestão de resposta</span><p>{suggestion.body}</p>
        {suggestion.warnings.map(w => <p className="assistant-warning" key={w}>{w}</p>)}
        {ready ? <div className="assistant-reply-actions"><button className="assistant-primary" type="button" disabled={sending} onClick={() => void send()}><Send size={15} />{sending ? 'Confirmando envio…' : 'Enviar resposta'}</button><button type="button" disabled={sending} onClick={() => { if (draftExists) setReplace(true); else onEdit(suggestion, false); }}><Pencil size={14} />Editar no campo</button></div> : <p className="assistant-caption">{generating ? 'Atualizando com as novas mensagens.' : suggestion.sendStatus === 'uncertain' ? 'Envio sem confirmação. Confira a conversa antes de reenviar.' : data.status === 'sent' ? 'Confira o status da mensagem na conversa.' : 'A conversa mudou. Gere uma sugestão atualizada.'}</p>}
        {replace ? <div className="assistant-confirm"><p>Substituir o texto que você já escreveu?</p><button type="button" onClick={() => { onEdit(suggestion, true); setReplace(false); }}>Substituir rascunho</button><button type="button" onClick={() => setReplace(false)}>Manter meu texto</button></div> : null}
      </section> : null}
      {!paused && !awaitingCustomer ? <form className="assistant-guidance" onSubmit={e => { e.preventDefault(); void generate(instruction.trim() || undefined); }}><label htmlFor="assistant-instruction">Orientar a IA <LockKeyhole size={12} /></label><textarea id="assistant-instruction" rows={3} maxLength={2000} value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="Ex.: seja mais direto e peça as medidas que faltam." disabled={generating || sending} /><div className="assistant-guidance-footer"><span>Não é enviado ao cliente</span><button type="submit" disabled={generating || sending}><RefreshCw size={14} />{suggestion ? 'Ajustar sugestão' : 'Gerar sugestão'}</button></div></form> : null}
      {data.error && !paused && !awaitingCustomer ? <p className="assistant-alert">{data.error}</p> : null}
      <details className="assistant-history"><summary>Histórico de revisões <span>{data.history.length}</span></summary>{data.history.length ? data.history.map(item => <article key={item.id}><div><strong>Revisão {item.revision}</strong><time>{new Date(item.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</time></div>{item.instruction ? <p className="assistant-history-instruction">Orientação: {item.instruction}</p> : null}<p>{item.body}</p>{item.finalBody ? <><span className="assistant-eyebrow"><Check size={12} /> Texto aprovado por {item.actorName ?? 'vendedor'}</span><p>{item.finalBody}</p></> : null}</article>) : <p>As sugestões e suas alterações aparecerão aqui.</p>}</details>
    </>}
    {handoffCompleted ? <details className="assistant-history handoff-archive"><summary>Ação anterior</summary>{handoffFeedback ? <p className="handoff-completed-feedback">{handoffFeedback}</p> : null}<div className="handoff-completed-actions"><button type="button" disabled={handoffBusy} onClick={onReopenHandoff}>Reabrir próxima ação</button><button type="button" disabled={handoffBusy} onClick={onReanalyzeHandoff}>Analisar resposta humana</button></div></details> : null}
  </div>;
}
