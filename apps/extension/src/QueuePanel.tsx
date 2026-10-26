import { useEffect, useRef, useState } from 'react';
import type { ExtensionAccount, ExtensionQueue, ExtensionQueueItem, ExtensionQueueKind } from '@prymeira-talk/shared';
import { runtimeRequest, type AccountContext } from './protocol';
import { humanReason } from './human-reason';
import { Icon, Initials, Prym, Skeleton } from './ui';
export const emptyCounts: ExtensionQueue['counts'] = { review: 0, reminders: 0, scheduled: 0, human: 0 };
const labels = { review: 'Para revisar', human: 'Precisam de você' };
export function QueuePanel({ context, account, view, hidden, busy, onCounts, onOpen }: {
  context: AccountContext; account: ExtensionAccount; view: 'followups'|'human'; hidden: boolean; busy: boolean;
  onCounts: (counts: ExtensionQueue['counts'])=>void; onOpen: (item: ExtensionQueueItem, kind: ExtensionQueueKind)=>void;
}) {
  const kind=view==='human'?'human':'review';
  const [result,setResult]=useState<ExtensionQueue|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState<string|null>(null);
  const [cursor,setCursor]=useState<string|undefined>(),[history,setHistory]=useState<Array<string|undefined>>([]);
  const epoch=useRef(0);
  const accountKey=`${context.scope}:${context.windowId}:${context.tabId}:${context.selfAddress}:${account.channelId}`;
  const currentKey=`${accountKey}:${kind}:${cursor??''}`; const currentRef=useRef(currentKey);currentRef.current=currentKey;
  async function load(silent=false) {
    const key=currentKey,generation=++epoch.current;if(!silent)setLoading(true);
    try {
      const value=await runtimeRequest<ExtensionQueue>({type:'QUEUE',context,account,kind,cursor});
      if(currentRef.current!==key||epoch.current!==generation)return;
      setResult(value);setError(null);onCounts(value.counts);
    } catch(cause) {
      if(currentRef.current!==key||epoch.current!==generation)return;
      const message=cause instanceof Error?cause.message:'Não foi possível consultar a fila.';
      if(cursor && message.includes('fila mudou')) {setCursor(undefined);setHistory([]);} else {setError(message);setResult(null);}
    } finally {if(currentRef.current===key&&epoch.current===generation)setLoading(false);}
  }
  useEffect(()=>{setCursor(undefined);setHistory([]);},[accountKey,kind]);
  useEffect(()=>{setResult(null);void load();const timer=setInterval(()=>void load(true),15_000);return()=>{++epoch.current;clearInterval(timer);};},[currentKey]);
  useEffect(()=>{if(!hidden)void load(true);},[hidden]);
  return <section className="queues view-enter" hidden={hidden} aria-busy={loading} aria-label={view==='human'?'Fila de humano necessário':'Fila de follow-ups'}>
    <div className="queue-heading"><h2>{labels[kind]}</h2><button className="icon-button" title="Atualizar fila" aria-label="Atualizar fila" onClick={()=>void load()} disabled={loading}><Icon name="refresh" className={loading?'is-loading':''}/></button></div>
    <p className="helper queue-help">{kind==='review'?'Abra a conversa e revise a mensagem.':'Abra a conversa para conferir o contexto. A pendência é concluída no Talk.'}</p>
    {error&&<div className="alert" role="alert">{error}</div>}
    {loading&&!result&&<div className="queue-loading" role="status"><span className="sr-only">Carregando fila…</span><Skeleton rows={6}/></div>}
    {result&&!result.items.length&&<div className="queue-empty"><Prym large/><h3>Tudo em dia por aqui.</h3><p>{kind==='review'?'Os próximos follow-ups para revisar vão aparecer aqui.':'As conversas que precisarem da sua atenção vão aparecer aqui.'}</p></div>}
    <ul className="queue-list">{result?.items.map(item=><li key={item.id}>
      <button className="queue-item" disabled={busy} onClick={()=>onOpen(item,kind)} aria-label={`${kind==='review'?'Abrir e preparar follow-up':'Abrir conversa'}: ${item.conversation.contactName??item.conversation.phone}`}>
        <Initials name={item.conversation.contactName??item.conversation.phone}/>
        <span className="queue-item-body"><strong>{item.conversation.contactName??item.conversation.phone}</strong>
          <span className="queue-detail">{kind==='human'?humanReason(item.reason):'Acompanhamento para revisar'}</span>
          {item.followup&&<span className="queue-date">{new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(item.followup.scheduledAt))}</span>}
        </span>
        <span className="queue-cta"><Icon name="arrow" size={17}/><span className="sr-only">{kind==='review'?'Abrir e preparar mensagem':'Abrir no WhatsApp'}</span></span>
      </button>
    </li>)}</ul>
    {(history.length>0||result?.nextCursor)&&<div className="queue-pagination"><button className="secondary" disabled={!history.length||loading||busy} onClick={()=>{setCursor(history.at(-1));setHistory(h=>h.slice(0,-1));}}>Anterior</button><span>{history.length+1}</span><button className="secondary" disabled={!result?.nextCursor||loading||busy} onClick={()=>{setHistory(h=>[...h,cursor]);setCursor(result!.nextCursor!);}}>Próxima</button></div>}
  </section>;
}
