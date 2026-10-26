import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExtensionChat, ExtensionRead, ExtensionSession, ExtensionAccount, ExtensionQueueItem, ExtensionQueueKind } from '@prymeira-talk/shared';
import { runtimeRequest, type PanelState, type SelectedContext, type AccountContext, type OpenChatResult } from './protocol';
import { canonicalPhone } from './whatsapp/identity';
import { QueuePanel, emptyCounts } from './QueuePanel';
import './panel.css';

function Mark() { return <svg width="25" height="28" viewBox="0 0 25 28" fill="none" aria-hidden="true"><path d="M3 25V3h10a8 8 0 0 1 0 16H9" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function Arrow() { return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function App() {
  const [state, setState] = useState<PanelState | null>(null), [fatal, setFatal] = useState<string | null>(null);
  const [channel, setChannel] = useState(''), [read, setRead] = useState<{ key: string; value: ExtensionRead } | null>(null);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false), [working, setWorking] = useState(false), [draft, setDraft] = useState('');
  const statusGeneration = useRef(0), liveRef = useRef(''), reading = useRef<string | null>(null), suggestionRef = useRef<string | null>(null);
  const [activeTab,setActiveTab]=useState<'conversation'|'followups'|'human'>('conversation');
  const [queueCounts,setQueueCounts]=useState(emptyCounts),[opening,setOpening]=useState(false),[navigationStatus,setNavigationStatus]=useState<string|null>(null);
  const [pendingNavigation,setPendingNavigation]=useState<(OpenChatResult & { started:number })|null>(null);
  const pendingToken=useRef<string|null>(null);pendingToken.current=pendingNavigation?.token??null;
  const preparing=useRef<string|null>(null),openingRef=useRef(false),navigationGeneration=useRef(0);
  const selection = state?.selection, session = state?.session;
  const matches = session?.channels.filter(c => selection?.selfAddress && canonicalPhone(c.phoneNumber) === canonicalPhone(selection.selfAddress)) ?? [];
  const selectedChannel = matches.some(c => c.id === channel) ? channel : matches.length === 1 ? matches[0]!.id : '';
  const key = state?.connected && session && selection?.phase === 'ready' && selectedChannel
    ? `${session.scope}:${state.windowId}:${state.tabId}:${selection.key}:${selectedChannel}` : '';
  liveRef.current = key;
  const context: SelectedContext | null = key && state?.tabId && session && selection ? { windowId: state.windowId, tabId: state.tabId, key: selection.key, scope: session.scope } : null;
  const chat: ExtensionChat | null = context && selection?.selfAddress && (selection.peerAddress || selection.lastMessageId) ? {
    channelId: selectedChannel, selfAddress: selection.selfAddress, peerAddress: selection.peerAddress, lastMessageId: selection.lastMessageId } : null;
  const accountContext:AccountContext|null=state?.connected&&session&&state.tabId&&selection?.selfAddress&&selectedChannel
    ? {windowId:state.windowId,tabId:state.tabId,scope:session.scope,selfAddress:selection.selfAddress}:null;
  const account:ExtensionAccount|null=accountContext?{channelId:selectedChannel,selfAddress:accountContext.selfAddress}:null;
  const data = read?.key === key && key ? read.value : null;
  const refreshStatus = useCallback(async () => {
    const generation = ++statusGeneration.current;
    try { const result = await runtimeRequest<PanelState>({ type: 'STATUS' });
      if (generation === statusGeneration.current) { setState(result); setFatal(null); }
    } catch (cause) { if (generation === statusGeneration.current) { setState(null); setRead(null); setFatal(message(cause)); } }
  }, []);
  useEffect(() => {
    const changed = (event: { type?: string;token?:string }) => {
      if(event.type==='NAVIGATION_CANCELLED'&&event.token===pendingToken.current){++navigationGeneration.current;setPendingNavigation(null);preparing.current=null;openingRef.current=false;setOpening(false);setNavigationStatus('Preparação interrompida pela navegação ou edição no WhatsApp. Seu rascunho foi preservado.');return;}
      if (event.type !== 'PANEL_CHANGED') return;
      // Clear synchronously on a navigation signal, before any asynchronous read can finish.
      liveRef.current = ''; setRead(null); setDraft(''); setState(previous => previous ? { ...previous, selection: null } : null); void refreshStatus();
    };
    chrome.runtime.onMessage.addListener(changed);
    void refreshStatus(); const timer = setInterval(() => void refreshStatus(), 5000);
    return () => { ++statusGeneration.current; clearInterval(timer); chrome.runtime.onMessage.removeListener(changed); };
  }, [refreshStatus]);
  async function load(silent = false) {
    if (!context || !chat || reading.current === key) return;
    const requestedKey = key; reading.current = requestedKey;
    if (!silent) setLoading(true);
    try {
      const result = await runtimeRequest<ExtensionRead>({ type: 'COMMAND', context, command: { action: 'read', chat } });
      if (liveRef.current !== requestedKey) return;
      setRead({ key: requestedKey, value: result }); setError(null);
      const suggestionId = result.assistant.suggestion?.id ?? null;
      if (suggestionRef.current !== suggestionId) { suggestionRef.current = suggestionId; setDraft(result.assistant.suggestion?.body ?? ''); }
    } catch (cause) { if (liveRef.current === requestedKey) { setRead(null); setDraft(''); setError(message(cause)); } }
    finally { if (reading.current === requestedKey) reading.current = null; if (liveRef.current === requestedKey) setLoading(false); }
  }
  useEffect(() => {
    setRead(null); setDraft(''); suggestionRef.current = null; setError(null); setNotice(null); setWorking(false); setLoading(false);
    if (key) void load();
    const timer = key ? setInterval(() => void load(true), 5000) : null;
    return () => { if (timer) clearInterval(timer); };
  }, [key]);
  useEffect(()=>{++navigationGeneration.current;setQueueCounts(emptyCounts);setPendingNavigation(null);preparing.current=null;openingRef.current=false;setOpening(false);setNavigationStatus(null);},[session?.scope,channel]);
  async function openQueue(item:ExtensionQueueItem,kind:ExtensionQueueKind) {
    if(!accountContext||!account||openingRef.current)return;
    const generation=++navigationGeneration.current;openingRef.current=true;setOpening(true);setNavigationStatus('Abrindo a conversa no WhatsApp…');setActiveTab('conversation');setPendingNavigation(null);preparing.current=null;
    try {
      const result=await runtimeRequest<OpenChatResult>({type:'OPEN_CHAT',context:accountContext,account,kind,id:item.id,expectedUpdatedAt:item.followup?.updatedAt});
      if(navigationGeneration.current!==generation)return;
      if(result.token){setPendingNavigation({...result,started:Date.now()});setNavigationStatus('Conferindo a conversa antes de preparar a mensagem…');}
      else {setNavigationStatus(kind==='human'?(item.reason??'Confira a conversa que precisa de atenção humana.'):kind==='reminders'?'Conversa aberta. Este item é um lembrete interno.':'Conversa aberta. O agendamento foi preservado.');openingRef.current=false;setOpening(false);}
    }catch(cause){if(navigationGeneration.current===generation){setNavigationStatus(message(cause));openingRef.current=false;setOpening(false);}}
  }
  useEffect(()=>{
    if(!pendingNavigation?.token)return;
    const timeout=setTimeout(()=>{setPendingNavigation(null);setNavigationStatus('A conversa ainda não ficou disponível para preparar a mensagem. Atualize e tente novamente.');openingRef.current=false;setOpening(false);},Math.max(0,60_000-(Date.now()-pendingNavigation.started)));
    if(data?.conversation.id===pendingNavigation.target.conversation.id&&context&&chat?.lastMessageId&&preparing.current!==pendingNavigation.token){
      const token=pendingNavigation.token;preparing.current=token;
      void runtimeRequest({type:'PREPARE_FOLLOWUP',context,chat,token}).then(()=>{
        if(preparing.current===token)setNavigationStatus('Mensagem preparada no WhatsApp. Revise o texto e clique em Enviar por lá.');
      }).catch(cause=>{if(preparing.current===token)setNavigationStatus(message(cause));}).finally(()=>{
        if(preparing.current===token){setPendingNavigation(null);openingRef.current=false;setOpening(false);}
      });
    }
    return()=>clearTimeout(timeout);
  },[pendingNavigation,key,data]);
  async function act(operation: () => Promise<unknown>, success?: string) {
    const startedKey = key; setWorking(true); setError(null); setNotice(null);
    try { await operation(); if (liveRef.current === startedKey) { setNotice(success ?? null); await load(true); } }
    catch (cause) { if (liveRef.current === startedKey) setError(message(cause)); }
    finally { if (liveRef.current === startedKey) setWorking(false); }
  }
  async function connect() { try { await runtimeRequest({ type: 'CONNECT' }); } catch (cause) { setFatal(message(cause)); } }
  const suggestion = data?.assistant.suggestion;
  const usable = !!suggestion && data?.assistant.status === 'ready' && suggestion.contextKey === data.assistant.currentContextKey;
  const followup = data?.followup;
  const actionableFollowup = followup && ['review', 'scheduled'].includes(followup.status);
  const emptyText = !state?.tabId ? 'Abra o WhatsApp Web neste navegador para começar.'
    : !selection || selection.phase === 'signed_out' ? 'Entre no WhatsApp Web e abra uma conversa.'
    : selection.phase === 'unsupported' ? 'O primeiro piloto está disponível para conversas individuais.'
    : selection.phase === 'switching' ? 'Identificando a nova conversa…'
    : selection.phase !== 'ready' ? 'Abra uma conversa com número ou identificador disponível. Nenhum contato será associado pelo nome.'
    : !matches.length ? 'O número aberto no WhatsApp Web precisa corresponder a um canal conectado e verificado no Talk.'
    : 'Escolha o canal do Talk para esta conversa.';
  return <div className="panel-shell">
    <header className="brand-header"><div className="brand-symbol"><Mark /></div><div className="brand-word">prymeira<span>talk</span></div><span className="pilot">PILOTO</span></header>
    <main>
      {fatal && <div className="alert" role="alert">{fatal}<button className="text-button" onClick={() => void refreshStatus()}>Tentar novamente</button></div>}
      {!state?.connected ? <section className="welcome">
        <div className="eyebrow">SEU ATENDIMENTO, COM CONTEXTO</div>
        <h1>A próxima resposta<br/><em>começa aqui.</em></h1>
        <p>As sugestões e os follow-ups do seu Talk, ao lado de cada conversa no WhatsApp.</p>
        <div className="welcome-visual" aria-hidden="true"><div className="visual-line"/><span className="visual-chip">Conversa</span><div className="visual-dot"/><span className="visual-chip green">Talk</span><div className="visual-line"/></div>
        <button className="primary wide" onClick={() => void connect()}>Conectar minha conta <Arrow /></button>
        <p className="helper">Entre com sua conta do Talk. No piloto, mantenha a aba de conexão aberta.</p>
        <div className="feature-row"><span className="feature-icon">↗</span><div><strong>Respostas com contexto</strong><span>O mesmo histórico e a mesma IA do Talk.</span></div></div>
        <div className="feature-row"><span className="feature-icon">◷</span><div><strong>O próximo passo à vista</strong><span>Acompanhe os retornos desta conversa.</span></div></div>
      </section> : <>
        <div className="connection"><span className="status-dot"/>Conta conectada <button className="text-button" onClick={() => { void runtimeRequest({ type: 'DISCONNECT' }).then(() => refreshStatus()); }}>Sair</button></div>
        <nav className="panel-tabs" aria-label="Navegação do Talk">
          <button aria-pressed={activeTab==='conversation'} onClick={()=>setActiveTab('conversation')}>Conversa</button>
          <button className="followups-tab" aria-pressed={activeTab==='followups'} onClick={()=>setActiveTab('followups')}>Follow-ups <span>{queueCounts.review}</span></button>
          <button aria-pressed={activeTab==='human'} onClick={()=>setActiveTab('human')}>Humano necessário <span>{queueCounts.human}</span></button>
        </nav>
        {navigationStatus&&<div className="notice" role="status">{navigationStatus}</div>}
        {accountContext&&account&&<QueuePanel context={accountContext} account={account} view={activeTab==='human'?'human':'followups'} hidden={activeTab==='conversation'} busy={opening} onCounts={setQueueCounts} onOpen={(item,kind)=>void openQueue(item,kind)}/>}
        {matches.length > 1 && <label className="channel-label">Canal do Talk<select aria-label="Canal do Talk" value={selectedChannel} onChange={e => setChannel(e.target.value)}><option value="">Escolher canal</option>{matches.map(c => <option value={c.id} key={c.id}>{c.displayName ?? c.phoneNumber}</option>)}</select></label>}
        {activeTab!=='conversation' ? (!accountContext&&<section className="empty-state"><p>{emptyText}</p></section>) : !key ? <section className="empty-state"><span className="empty-icon" aria-hidden="true">↔</span><h1>Vamos abrir uma conversa?</h1><p>{emptyText}</p></section> : <>
          <section className="contact-heading"><div className="eyebrow">CONVERSA ATUAL</div><h1>{data?.conversation.contactName ?? selection?.label ?? 'Identificando contato…'}</h1><div className="contact-meta">{data?.conversation.phone ?? selection?.peerAddress?.replace(/@.+$/, '')}<span>·</span>{matches.find(c => c.id === selectedChannel)?.displayName ?? 'Canal Talk'}</div></section>
          {error && <div className="alert" role="alert">{error}<button className="text-button" onClick={() => void load()}>Atualizar</button></div>}
          {notice && <div className="notice" role="status">{notice}</div>}
          {loading && !data && <div className="loading" role="status"><span className="status-dot"/>Buscando contexto no Talk…</div>}
          {data && <>
            <section className="card suggestion-card"><div className="card-top"><h2><span aria-hidden="true">✳</span> Sugestão de resposta</h2><span className="subtle">{data.assistant.agentName ?? 'IA do Talk'}</span></div>
              {usable ? <><label className="sr-only" htmlFor="reply">Revise a sugestão</label><textarea id="reply" value={draft} onChange={e => setDraft(e.target.value)} maxLength={4000} rows={6}/>
                {suggestion?.warnings.map((warning, i) => <p className="warning" key={i}>{warning}</p>)}
                <button className="primary wide" disabled={working || !draft.trim()} onClick={() => context && chat && suggestion && void act(() => runtimeRequest({ type: 'INSERT', context, chat, suggestionId: suggestion.id, contextKey: suggestion.contextKey, body: draft }), 'Inserida no WhatsApp. Revise antes de enviar.')}>Inserir no WhatsApp <Arrow /></button><p className="helper">Você revisa e envia pelo WhatsApp.</p></>
                : <p className="card-copy">{data.assistant.status === 'generating' || data.assistant.status === 'pending' ? 'O Talk está preparando a sugestão…' : data.assistant.status === 'paused' ? 'A IA está pausada para esta conversa.' : data.assistant.settings.mode === 'disabled' ? 'Habilite a IA de apoio deste canal no Talk.' : data.assistant.error ?? 'Peça uma sugestão com base no histórico desta conversa.'}</p>}
              <button className="secondary wide" disabled={working || ['pending', 'generating', 'paused'].includes(data.assistant.status) || data.assistant.settings.mode === 'disabled'} onClick={() => context && chat && void act(() => runtimeRequest({ type: 'COMMAND', context, command: { action: 'generate', chat } }), 'Sugestão solicitada ao Talk.')}>{usable ? 'Gerar outra sugestão' : 'Gerar sugestão'}</button>
            </section>
            <section className="card followup-card"><div className="card-top"><h2><span aria-hidden="true">◷</span> Próximo retorno</h2>{followup && <span className="badge">{followup.kind === 'seller_reminder' ? 'Lembrete' : followup.status === 'review' ? 'Em revisão' : 'Agendado'}</span>}</div>
              {followup ? <><p className="followup-title">{followup.analysis?.pendingItem ?? 'Acompanhamento desta conversa'}</p><p className="due">{new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(followup.scheduledAt))}</p>
                {followup.analysis?.nextStep && <p className="card-copy">{followup.analysis.nextStep}</p>}
                {followup.draftBody && <blockquote>{followup.draftBody}</blockquote>}
                {actionableFollowup && <div className="followup-actions"><button className="secondary" disabled={working} onClick={() => context && chat && void act(() => runtimeRequest({ type: 'COMMAND', context, command: { action: 'followup', chat, id: followup.id, operation: followup.kind === 'seller_reminder' ? 'done' : 'postpone', expectedUpdatedAt: followup.updatedAt } }), 'Acompanhamento atualizado.')}>{followup.kind === 'seller_reminder' ? 'Marcar como feito' : 'Adiar 1h útil'}</button>
                  <button className="text-button" disabled={working} onClick={() => context && chat && void act(() => runtimeRequest({ type: 'COMMAND', context, command: { action: 'followup', chat, id: followup.id, operation: 'cancel', expectedUpdatedAt: followup.updatedAt } }), 'Acompanhamento cancelado.')}>Cancelar</button></div>}</>
                : <p className="card-copy">Nenhum follow-up ativo para esta conversa. Os acompanhamentos configurados no Talk aparecerão aqui.</p>}
            </section>
            <button className="refresh-button" disabled={working || loading} onClick={() => void load()}>↻ Atualizar contexto</button>
          </>}
        </>}
      </>}
    </main>
    <footer className="panel-footer"><span className="footer-mark">p.</span><span>O contexto acompanha a conversa.</span><span>0.2.3</span></footer>
  </div>;
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : 'Não foi possível carregar o Talk.'; }
createRoot(document.getElementById('root')!).render(<App />);
