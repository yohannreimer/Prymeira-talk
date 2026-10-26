import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExtensionChat, ExtensionRead, ExtensionSession, ExtensionAccount, ExtensionQueueItem, ExtensionQueueKind } from '@prymeira-talk/shared';
import { runtimeRequest, type PanelState, type SelectedContext, type AccountContext, type OpenChatResult } from './protocol';
import { canonicalPhone } from './whatsapp/identity';
import { QueuePanel, emptyCounts } from './QueuePanel';
import { humanReason } from './human-reason';
import { Icon, Prym, Initials, Skeleton } from './ui';
import './panel.css';

function App() {
  const [connecting,setConnecting]=useState(false);const connectInFlight=useRef(false);
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
  // Keep progress visible while work is running; finished feedback frees the space after 5s.
  useEffect(()=>{if(!navigationStatus||opening)return;const timer=setTimeout(()=>setNavigationStatus(null),5000);return()=>clearTimeout(timer);},[navigationStatus,opening]);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(null),5000);return()=>clearTimeout(timer);},[notice]);
  async function openQueue(item:ExtensionQueueItem,kind:ExtensionQueueKind) {
    if(!accountContext||!account||openingRef.current)return;
    const generation=++navigationGeneration.current;openingRef.current=true;setOpening(true);setNavigationStatus('Abrindo a conversa no WhatsApp…');setActiveTab('conversation');setPendingNavigation(null);preparing.current=null;
    try {
      const result=await runtimeRequest<OpenChatResult>({type:'OPEN_CHAT',context:accountContext,account,kind,id:item.id,expectedUpdatedAt:item.followup?.updatedAt});
      if(navigationGeneration.current!==generation)return;
      if(result.token){setPendingNavigation({...result,started:Date.now()});setNavigationStatus('Conferindo a conversa antes de preparar a mensagem…');}
      else {setNavigationStatus(kind==='human'?humanReason(item.reason):kind==='reminders'?'Conversa aberta. Este item é um lembrete interno.':'Conversa aberta. O agendamento foi preservado.');openingRef.current=false;setOpening(false);}
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
  async function connect() { if(connectInFlight.current)return;connectInFlight.current=true;setConnecting(true);setFatal(null);try { await runtimeRequest({ type: 'CONNECT' }); } catch (cause) { setFatal(message(cause)); } finally {connectInFlight.current=false;setConnecting(false);} }
  const suggestion = data?.assistant.suggestion;
  const usable = !!suggestion && data?.assistant.status === 'ready' && suggestion.contextKey === data.assistant.currentContextKey;
  const emptyText = !state?.tabId ? 'Abra o WhatsApp Web neste navegador para começar.'
    : !selection || selection.phase === 'signed_out' ? 'Entre no WhatsApp Web e abra uma conversa.'
    : selection.phase === 'unsupported' ? 'O primeiro piloto está disponível para conversas individuais.'
    : selection.phase === 'switching' ? 'Identificando a nova conversa…'
    : selection.phase !== 'ready' ? 'Abra uma conversa com número ou identificador disponível. Nenhum contato será associado pelo nome.'
    : !matches.length ? 'O número aberto no WhatsApp Web precisa corresponder a um canal conectado e verificado no Talk.'
    : 'Escolha o canal do Talk para esta conversa.';
  return <div className="panel-shell">
    <header className="brand-header"><div className="brand-lockup"><img src="assets/prymeira.png" alt="Prymeira" width="125" height="36"/><span>talk</span></div>{state?.connected&&<button className="text-button header-signout" onClick={() => { void runtimeRequest({ type: 'DISCONNECT' }).then(() => refreshStatus()); }}>Sair <Icon name="logout" size={16}/></button>}</header>
    <main>
      {state?.connectionError&&!fatal&&<div className="alert" role="alert">{state.connectionError}</div>}
      {fatal && <div className="alert" role="alert">{fatal}<button className="text-button" onClick={() => void refreshStatus()}>Tentar novamente</button></div>}
      {!state?.connected ? <section className="welcome">
        <Prym large/>
        <div className="eyebrow">PRYM, SEU ASSISTENTE NO WHATSAPP</div>
        <h1>Seu Talk.<br/>Mais perto da conversa.</h1>
        <p>Sugestões prontas, follow-ups para revisar e os contatos que precisam de você.</p>
        <button className="primary wide" disabled={connecting} onClick={() => void connect()}>{connecting?'Conectando…':'Conectar minha conta'} <Icon name="arrow"/></button>
        <p className="helper">Use a mesma conta e o mesmo número conectados ao Talk.</p>
      </section> : <>
        <nav className="panel-tabs" aria-label="Navegação do Talk">
          <button aria-pressed={activeTab==='conversation'} onClick={()=>{setActiveTab('conversation');setNavigationStatus(null);setNotice(null);}}>Conversa</button>
          <button className="followups-tab" aria-pressed={activeTab==='followups'} onClick={()=>{setActiveTab('followups');setNavigationStatus(null);setNotice(null);}}>Follow-ups <span>{queueCounts.review}</span></button>
          <button aria-pressed={activeTab==='human'} onClick={()=>{setActiveTab('human');setNavigationStatus(null);setNotice(null);}}>Humano necessário <span>{queueCounts.human}</span></button>
        </nav>
        {accountContext&&account&&<QueuePanel context={accountContext} account={account} view={activeTab==='human'?'human':'followups'} hidden={activeTab==='conversation'} busy={opening} onCounts={setQueueCounts} onOpen={(item,kind)=>void openQueue(item,kind)}/>}
        {matches.length > 1 && <label className="channel-label">Canal do Talk<select aria-label="Canal do Talk" value={selectedChannel} onChange={e => setChannel(e.target.value)}><option value="">Escolher canal</option>{matches.map(c => <option value={c.id} key={c.id}>{c.displayName ?? c.phoneNumber}</option>)}</select></label>}
        {activeTab!=='conversation' ? (!accountContext&&<section className="empty-state"><p>{emptyText}</p></section>) : !key ? <section className="empty-state"><Prym large/><h1>Vamos abrir uma conversa?</h1><p>{emptyText}</p></section> : <>
          <section className="contact-heading"><Initials name={data?.conversation.contactName ?? selection?.label ?? ''}/><div className="contact-identity"><h1>{data?.conversation.contactName ?? selection?.label ?? 'Identificando contato…'}</h1><div className="contact-meta">{data?.conversation.phone ?? selection?.peerAddress?.replace(/@.+$/, '')}<span>·</span>{matches.find(c => c.id === selectedChannel)?.displayName ?? 'Canal Talk'}</div></div></section>
          {error && <div className="alert" role="alert">{error}<button className="text-button" onClick={() => void load()}>Atualizar</button></div>}
          {loading && !data && <div className="loading" role="status"><span className="sr-only">Buscando contexto no Talk…</span><Skeleton rows={5}/></div>}
          {data && <>
            <section className="suggestion-card"><div className="assistant-heading"><Prym/><div><strong>Prym</strong><h2>Sugestão de resposta</h2></div></div><p className="agent-source">{data.assistant.agentName ? `IA do canal: ${data.assistant.agentName}` : 'Com o contexto do seu Talk'}</p>
              {usable ? <><label className="sr-only" htmlFor="reply">Revise a sugestão</label><textarea id="reply" value={draft} onChange={e => setDraft(e.target.value)} maxLength={4000} rows={7}/>
                {suggestion?.warnings.map((warning, i) => <p className="warning" key={i}>{warning}</p>)}
                <button className="primary wide" disabled={working || !draft.trim()} onClick={() => context && chat && suggestion && void act(() => runtimeRequest({ type: 'INSERT', context, chat, suggestionId: suggestion.id, contextKey: suggestion.contextKey, body: draft }), 'Inserida no WhatsApp. Revise antes de enviar.')}>Inserir no WhatsApp <Icon name="arrow"/></button><p className="helper">Você revisa e envia pelo WhatsApp.</p></>
                : <p className="card-copy">{data.assistant.status === 'generating' || data.assistant.status === 'pending' ? 'O Talk está preparando a sugestão…' : data.assistant.status === 'paused' ? 'A IA está pausada para esta conversa.' : data.assistant.settings.mode === 'disabled' ? 'Habilite a IA de apoio deste canal no Talk.' : data.assistant.error ?? 'Peça uma sugestão com base no histórico desta conversa.'}</p>}
              <button className="secondary wide" disabled={working || ['pending', 'generating', 'paused'].includes(data.assistant.status) || data.assistant.settings.mode === 'disabled'} onClick={() => context && chat && void act(() => runtimeRequest({ type: 'COMMAND', context, command: { action: 'generate', chat } }), 'Sugestão solicitada ao Talk.')}><Icon name="refresh"/>{usable ? 'Gerar outra sugestão' : 'Gerar sugestão'}</button>
            </section>
            <button className="refresh-button" disabled={working || loading} onClick={() => void load()}><Icon name="refresh" size={15}/>Atualizar contexto</button>
          </>}
        </>}
      </>}
    </main>
    {(navigationStatus||notice)&&<div className="feedback-stack"><div className="notice" role="status"><Icon name={opening?'clock':'check'} size={18}/><span>{navigationStatus||notice}</span><button className="icon-button" aria-label="Dispensar aviso" onClick={()=>{setNavigationStatus(null);setNotice(null);}}><Icon name="close" size={16}/></button></div></div>}
    <footer className="panel-footer"><span>{state?.connected?'Conectado ao seu Talk':'Prymeira Talk para WhatsApp'}</span><span>0.3.0</span></footer>
  </div>;
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : 'Não foi possível carregar o Talk.'; }
createRoot(document.getElementById('root')!).render(<App />);
