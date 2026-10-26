import { useEffect, useRef, useState } from 'react';
import { EXTENSION_BRIDGE_REQUEST, EXTENSION_BRIDGE_RESPONSE, EXTENSION_BRIDGE_STATUS, EXTENSION_BRIDGE_PING, EXTENSION_BRIDGE_DISCONNECT, type ExtensionReply } from '@prymeira-talk/shared';
import { useTalkAuth } from '../../app/auth';
import { readConfigValue } from '../../app/runtime-config';
import { executeExtensionCommand } from './extension-bridge';
import './extension-bridge.css';

export function ExtensionBridgePage() {
  const auth = useTalkAuth();
  const identity = `${auth.userId ?? ''}:${auth.sessionId ?? ''}:${auth.orgId ?? ''}`;
  return <Connection key={identity} identity={identity} getToken={auth.getToken} />;
}
function Connection({ identity, getToken }: { identity: string; getToken: () => Promise<string | null> }) {
  const [allowed, setAllowed] = useState(false), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const allowedRef = useRef(false), tokenRef = useRef(getToken); tokenRef.current = getToken;
  const lifetime = useRef(new AbortController());
  const apiUrl = readConfigValue('VITE_API_URL') ?? 'http://localhost:3002';
  const announce = (connected: boolean, reason?:'user'|'revoked'|'closed') => window.postMessage({ type: EXTENSION_BRIDGE_STATUS, connected, reason }, location.origin);
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (lifetime.current.signal.aborted || (init.method && init.method !== 'GET' && !allowedRef.current)) throw new Error('Conexão encerrada.');
    const token = await tokenRef.current();
    if (lifetime.current.signal.aborted || (init.method && init.method !== 'GET' && !allowedRef.current)) throw new Error('Conexão encerrada.');
    if (!token) throw new Error('Entre novamente na sua conta do Talk.');
    const response = await fetch(`${apiUrl}${path}`, { ...init, signal: AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(20_000)]), cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) { allowedRef.current = false; setAllowed(false); announce(false); }
      throw new Error(typeof data.error === 'string' ? data.error : data.error?.message ?? `Talk indisponível (${response.status}).`);
    }
    return data as T;
  }
  useEffect(() => {
    let mounted = true;
    const handle = async (event: MessageEvent) => {
      const data = event.data;
      if (event.source !== window || event.origin !== location.origin) return;
      if (data?.type === EXTENSION_BRIDGE_PING) { announce(allowedRef.current); return; }
      if (data?.type === EXTENSION_BRIDGE_DISCONNECT) { allowedRef.current = false; setAllowed(false); announce(false); return; }
      if (data?.type !== EXTENSION_BRIDGE_REQUEST
        || typeof data.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(data.requestId)) return;
      let result: ExtensionReply;
      try {
        if (!allowedRef.current) throw new Error('Autorize a conexão nesta aba do Talk.');
        result = await executeExtensionCommand(data.command, request, identity);
      } catch (cause) { result = { ok: false, error: cause instanceof Error ? cause.message : 'Não foi possível consultar o Talk.' }; }
      if (!mounted) return;
      // Logout, revoked access or a changed account fences requests already in flight.
      if (!allowedRef.current) result = { ok: false, error: 'Conexão encerrada. Autorize novamente no Talk.' };
      window.postMessage({ type: EXTENSION_BRIDGE_RESPONSE, requestId: data.requestId, result }, location.origin);
    };
    const revoked = () => { allowedRef.current = false; setAllowed(false); announce(false,'revoked'); };
    window.addEventListener('message', handle); window.addEventListener('talk:access-revoked', revoked);
    return () => { mounted = false; allowedRef.current = false; lifetime.current.abort(); announce(false,'closed'); window.removeEventListener('message', handle); window.removeEventListener('talk:access-revoked', revoked); };
  }, [identity]);
  async function connect() {
    setBusy(true); setError(null);
    try { await executeExtensionCommand({ action: 'session' }, request, identity); allowedRef.current = true; setAllowed(true); announce(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível conectar.'); }
    finally { setBusy(false); }
  }
  return <main className="extension-connect"><div className="extension-connect-card">
    <div className="extension-brand">prymeira<span>talk / extensão</span></div>
    <div className={`extension-connection-dot ${allowed ? 'connected' : ''}`} aria-hidden="true" />
    <h1>{allowed ? 'Talk conectado ao seu navegador.' : 'Seu Talk, ao lado das conversas.'}</h1>
    <p>{allowed ? 'Volte ao WhatsApp Web e abra o painel da extensão. Mantenha esta aba aberta durante o piloto.'
      : 'Conecte sua conta para consultar sugestões de resposta e follow-ups no WhatsApp Web, com as mesmas permissões do Talk.'}</p>
    {error && <p role="alert" className="extension-connect-error">{error}</p>}
    {allowed ? <button onClick={() => { allowedRef.current = false; setAllowed(false); announce(false,'user'); }}>Desconectar extensão</button>
      : <button disabled={busy} onClick={() => void connect()}>{busy ? 'Verificando acesso…' : 'Conectar minha conta'}</button>}
    <small>Primeiro piloto · número já conectado ao Talk</small>
  </div></main>;
}
