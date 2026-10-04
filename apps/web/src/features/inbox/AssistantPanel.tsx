import { useRef, useState } from 'react';
import { Check, LockKeyhole, MessageSquareText, Pencil, Plus, RefreshCw, Send, UserRound } from 'lucide-react';
import type { AssistantConversationDto, AssistantSuggestionDto } from '@prymeira-talk/shared';
import { HandoffBrief } from './HandoffBrief';
import type { HandoffBriefDto } from '../../../../../packages/shared/src/assistant';

type Props = {
  data: AssistantConversationDto | null; error: string | null; humanControlled: boolean;
  /** The first answer for this conversation has not arrived yet. */
  loading?: boolean;
  /** Who wrote last, from the thread on screen: flips the panel the moment the seller sends, before the server answers. */
  lastFromUs?: boolean;
  draftExists: boolean; sending: boolean;
  handoffBrief?: HandoffBriefDto | null;
  handoffCompleted: boolean; handoffFeedback: string | null; handoffBusy: boolean;
  onCompleteHandoff: () => void; onReopenHandoff: () => void; onReanalyzeHandoff: () => void;
  onGenerate: (instruction?: string) => Promise<void>;
  onSend: (suggestion: AssistantSuggestionDto) => Promise<void>;
  onEdit: (suggestion: AssistantSuggestionDto, confirmed: boolean) => void;
};
export function AssistantPanel({ data, error, loading, lastFromUs, humanControlled, draftExists, sending, handoffBrief, handoffCompleted, handoffFeedback, handoffBusy, onCompleteHandoff, onReopenHandoff, onReanalyzeHandoff, onGenerate, onSend, onEdit }: Props) {
  const [instruction, setInstruction] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [replace, setReplace] = useState(false);
  /** The guidance box stays folded until asked for: the panel shows the state and its action first. */
  const [orientOpen, setOrientOpen] = useState(false);
  const busy = useRef(false);
  const suggestion = data?.suggestion;
  const paused = (humanControlled || data?.humanControlled) && !data?.humanSupport;
  const handoffPending = Boolean(handoffBrief && !handoffCompleted);
  // Three states only, by who wrote last: a reply to suggest, waiting for the customer (follow-up on request), or a human
  // in control. What happens inside (preparing, ready, failed) stays in the card, so the panel does not jump around.
  const awaitingCustomer = Boolean((lastFromUs ?? data?.awaitingCustomer) && !handoffPending);
  const generating = requesting || data?.status === 'generating' || data?.status === 'pending';
  const ready = data?.status === 'ready' && !paused && !generating && !(lastFromUs && !data?.awaitingCustomer);
  const followUp = Boolean(awaitingCustomer && ready && suggestion);
  const stateLabel = paused ? 'Humano no controle' : awaitingCustomer ? 'Aguardando o cliente' : 'Sugestão de resposta';
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
    {(localError || (!handoffPending && error)) ? <p className="assistant-alert" role="alert">{localError ?? error}</p> : null}
    {handoffPending ? <HandoffBrief brief={handoffBrief!} busy={handoffBusy} onComplete={onCompleteHandoff} /> : null}
    {!data ? !handoffPending ? loading ? <div className="assistant-loading" aria-label="Carregando o apoio"><span /><span /><span /></div>
      : <div className="assistant-empty">{error ? 'Tente abrir novamente o apoio.' : 'Selecione uma conversa para acompanhar as sugestões.'}</div> : null : data.settings.mode === 'disabled' ? !handoffPending ? <div className="assistant-empty"><MessageSquareText size={24} /><h3>Apoio não ativado</h3><p>Um gestor pode escolher o agente e ativar as sugestões em Canais.</p></div> : null : handoffPending ? null : <>
      <div className="assistant-state" role="status"><span className={`assistant-status-dot${paused ? ' is-paused' : ''}`} /><span key={stateLabel} className="assistant-fade">{stateLabel}</span><small>{data.agentName}</small></div>
      {paused ? <div className="assistant-empty"><UserRound size={24} /><h3>O atendimento está com você</h3><p>A IA não gera sugestões enquanto o humano está no controle. Você pode continuar pelo campo de mensagem.</p></div> : null}
      {!paused && awaitingCustomer && !ready && !generating ? <p className="assistant-caption">A última mensagem foi sua. Quando o cliente responder, a IA sugere a resposta. Se quiser retomar o contato antes, peça um follow-up.</p> : null}
      {!paused && !awaitingCustomer && !ready && !generating ? <p className="assistant-caption">Gere uma sugestão para responder mais rápido. Você revisa antes de enviar.</p> : null}
      {!paused && generating ? <section className="assistant-reply is-preparing" aria-label="Preparando"><span className="assistant-eyebrow">{awaitingCustomer ? 'Preparando follow-up…' : 'Preparando sugestão…'}</span><div className="assistant-loading is-inline"><span /><span /><span /></div></section> : null}
      {!paused && suggestion && ready ? <section className={`assistant-reply${!ready ? ' is-outdated' : ''}`} aria-label={followUp ? 'Follow-up sugerido' : 'Resposta sugerida'}><span className="assistant-eyebrow">{followUp ? 'Sugestão de follow-up' : 'Sugestão de resposta'}</span><p>{suggestion.body}</p>
        {suggestion.warnings.map(w => <p className="assistant-warning" key={w}>{w}</p>)}
        {ready ? <div className="assistant-reply-actions"><button className="assistant-primary" type="button" disabled={sending} onClick={() => void send()}><Send size={15} />{sending ? 'Confirmando envio…' : 'Enviar resposta'}</button><button type="button" disabled={sending} onClick={() => { if (draftExists) setReplace(true); else onEdit(suggestion, false); }}><Pencil size={14} />Editar no campo</button></div> : <p className="assistant-caption">{generating ? 'Atualizando com as novas mensagens.' : suggestion.sendStatus === 'uncertain' ? 'Envio sem confirmação. Confira a conversa antes de reenviar.' : data.status === 'sent' ? 'Confira o status da mensagem na conversa.' : 'A conversa mudou desde esta sugestão. Atualize para usar as mensagens novas.'}</p>}
        {replace ? <div className="assistant-confirm"><p>Substituir o texto que você já escreveu?</p><button type="button" onClick={() => { onEdit(suggestion, true); setReplace(false); }}>Substituir rascunho</button><button type="button" onClick={() => setReplace(false)}>Manter meu texto</button></div> : null}
      </section> : null}
      {!paused ? <form className="assistant-guidance" onSubmit={e => { e.preventDefault(); void generate(instruction.trim() || undefined); }}>{orientOpen || instruction ? <><label htmlFor="assistant-instruction">Orientar a IA <LockKeyhole size={12} /></label><textarea id="assistant-instruction" rows={3} maxLength={2000} value={instruction} onChange={e => setInstruction(e.target.value)} placeholder={awaitingCustomer ? 'Opcional. Ex.: lembre do orçamento enviado ontem.' : 'Ex.: seja mais direto e peça as medidas que faltam.'} disabled={generating || sending} autoFocus={orientOpen && !instruction} /></>
        : <button type="button" className="assistant-orient-toggle" onClick={() => setOrientOpen(true)}><Plus size={14} aria-hidden="true" />Orientar a IA</button>}<div className="assistant-guidance-footer"><span>Não é enviado ao cliente</span><button type="submit" disabled={generating || sending}><RefreshCw size={14} />{awaitingCustomer ? (followUp ? 'Ajustar follow-up' : 'Sugerir follow-up') : suggestion && ready ? 'Ajustar sugestão' : 'Gerar sugestão'}</button></div></form> : null}
      {data.error && data.status === 'failed' && !paused && !generating ? <p className="assistant-alert">{data.error}</p> : null}
      <details className="assistant-history"><summary>Histórico de revisões <span>{data.history.length}</span></summary>{data.history.length ? data.history.map(item => <article key={item.id}><div><strong>Revisão {item.revision}</strong><time>{new Date(item.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</time></div>{item.instruction ? <p className="assistant-history-instruction">Orientação: {item.instruction}</p> : null}<p>{item.body}</p>{item.finalBody ? <><span className="assistant-eyebrow"><Check size={12} /> Texto aprovado por {item.actorName ?? 'vendedor'}</span><p>{item.finalBody}</p></> : null}</article>) : <p>As sugestões e suas alterações aparecerão aqui.</p>}</details>
    </>}
    {handoffCompleted ? <details className="assistant-history handoff-archive"><summary>Ação anterior</summary>{handoffFeedback ? <p className="handoff-completed-feedback">{handoffFeedback}</p> : null}<div className="handoff-completed-actions"><button type="button" disabled={handoffBusy} onClick={onReopenHandoff}>Reabrir próxima ação</button><button type="button" disabled={handoffBusy} onClick={onReanalyzeHandoff}>Analisar respostas humanas</button></div></details> : humanControlled && data?.settings.mode !== 'disabled' ? <div className="handoff-completed-actions"><button type="button" disabled={handoffBusy} onClick={onReanalyzeHandoff}>Analisar respostas humanas</button>{handoffFeedback ? <p className="handoff-completed-feedback">{handoffFeedback}</p> : null}</div> : null}
  </div>;
}
