import { useEffect, useRef, useState } from 'react';
import type { ExtensionAccount, ExtensionQueue, ExtensionQueueItem, ExtensionQueueKind } from '@prymeira-talk/shared';
import { runtimeRequest, type AccountContext } from './protocol';
export const emptyCounts: ExtensionQueue['counts'] = { review: 0, reminders: 0, scheduled: 0, human: 0 };
const labels = { review: 'Para revisar', reminders: 'Lembretes', scheduled: 'Agendados', human: 'Humano necessário' };
export function QueuePanel({ context, account, view, hidden, busy, onCounts, onOpen }: {
  context: AccountContext; account: ExtensionAccount; view: 'followups'|'human'; hidden: boolean; busy: boolean;
  onCounts: (counts: ExtensionQueue['counts'])=>void; onOpen: (item: ExtensionQueueItem, kind: ExtensionQueueKind)=>void;
}) {
  const [filter,setFilter]=useState<Exclude<ExtensionQueueKind,'human'>>('review');
  const kind=view==='human'?'human':filter;
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
  useEffect(()=>{setResult(null);void load();const timer=setInterval(()=>void load(true),15_000);return()=>{++epoch.current;clearInterval(timer);};},[currentKey,hidden]);
  return <section className="queues" hidden={hidden} aria-label={view==='human'?'Fila de humano necessário':'Fila de follow-ups'}>
    {view==='followups'&&<div className="queue-filters" role="group" aria-label="Estado dos follow-ups">{(['review','reminders','scheduled'] as const).map(k=><button key={k} className={kind===k?'is-active':''} aria-pressed={kind===k} onClick={()=>setFilter(k)}>{labels[k]}</button>)}</div>}
    <div className="queue-heading"><h2>{labels[kind]}</h2><button className="text-button" onClick={()=>void load()} disabled={loading}>Atualizar fila</button></div>
    <p className="helper queue-help">{kind==='review'?'Abra o follow-up para ler a conversa e deixar a mensagem pronta no WhatsApp.':kind==='human'?'Abra a conversa que precisa da sua atenção. A ação continua pendente até ser concluída no Talk.':kind==='reminders'?'Lembretes internos para a equipe; abrir não prepara uma mensagem para o cliente.':'Acompanhamentos agendados; abrir não antecipa o envio automático.'}</p>
    {error&&<div className="alert" role="alert">{error}</div>}
    {loading&&!result&&<p role="status">Carregando fila…</p>}
    {result&&!result.items.length&&<p className="queue-empty">Nenhuma pendência nesta fila.</p>}
    <ul className="queue-list">{result?.items.map(item=><li key={item.id}>
      <button className="queue-item" disabled={busy} onClick={()=>onOpen(item,kind)} aria-label={`${kind==='review'?'Abrir e preparar follow-up':'Abrir conversa'}: ${item.conversation.contactName??item.conversation.phone}`}>
        <strong>{item.conversation.contactName??item.conversation.phone}</strong><span>{item.conversation.phone}</span>
        {item.reason&&<p>{item.reason}</p>}
        {item.followup&&<span>{new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short'}).format(new Date(item.followup.scheduledAt))}</span>}
        <span className="queue-cta">{kind==='review'?'Abrir e preparar mensagem':'Abrir no WhatsApp'} ↗</span>
      </button>
    </li>)}</ul>
    {(history.length>0||result?.nextCursor)&&<div className="queue-pagination"><button className="secondary" disabled={!history.length||loading||busy} onClick={()=>{setCursor(history.at(-1));setHistory(h=>h.slice(0,-1));}}>Anterior</button><span>{history.length+1}</span><button className="secondary" disabled={!result?.nextCursor||loading||busy} onClick={()=>{setHistory(h=>[...h,cursor]);setCursor(result!.nextCursor!);}}>Próxima</button></div>}
  </section>;
}
