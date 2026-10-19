import { QueryClientProvider } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type PropsWithChildren, type SetStateAction } from 'react';
import { apiGetCurrentTalkUser, type CurrentTalkUserDto } from '../api';
import { useTalkAuth } from '../auth';
import { ReadAccessError, withReadDeadline } from '../read-request';
import { RealtimeConnection } from '../../features/inbox/realtime-connection';
import { ContactPhotoProvider } from '../../features/inbox/ContactAvatar';
import { TalkSession } from './talk-session';

type SessionContextValue = { session: TalkSession; realtime: RealtimeConnection; currentUser: CurrentTalkUserDto; getToken: () => Promise<string | null> };
export const TalkSessionContext = createContext<SessionContextValue | null>(null);
export function useOptionalTalkSession() { return useContext(TalkSessionContext); }
export function useTalkSession() {
  const context = useOptionalTalkSession();
  if (!context) throw new Error('Atendimento requires a scoped Talk session.');
  return context;
}
export function useSessionState<T>(key: string, fallback: T): [T, (value: SetStateAction<T>) => void] {
  const { session } = useTalkSession();
  const subscribe = useCallback((listener: () => void) => session.subscribeUI(key, listener), [session, key]);
  const snapshot = useCallback(() => session.readUI(key, fallback), [session, key, fallback]);
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  const set = useCallback((next: SetStateAction<T>) => session.writeUI(key, next, fallback), [session, key, fallback]);
  return [value, set];
}

export function TalkSessionProvider({ children }: PropsWithChildren) {
  const auth = useTalkAuth();
  const identity = `${auth.userId ?? 'local'}:${auth.sessionId ?? 'local'}:${auth.orgId ?? ''}`;
  return <AuthenticatedScope key={identity} identity={identity} getToken={auth.getToken}>{children}</AuthenticatedScope>;
}
function AuthenticatedScope({ children, identity, getToken }: PropsWithChildren<{ identity: string; getToken: () => Promise<string | null> }>) {
  const tokenRef = useRef(getToken); tokenRef.current = getToken;
  const stableToken = useCallback(() => tokenRef.current(), []);
  const [currentUser, setCurrentUser] = useState<CurrentTalkUserDto | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    let busy = false;
    const validate = async () => {
      if (busy || abort.signal.aborted) return;
      busy = true;
      try {
        const user = await apiGetCurrentTalkUser(stableToken, abort.signal);
        if (!user.workspaceId) throw new Error('Workspace indisponível.');
        if (!abort.signal.aborted) { setCurrentUser(user); setFailure(null); }
      } catch (error) {
        if (!abort.signal.aborted) {
          setFailure(error instanceof Error ? error.message : 'Não foi possível validar o acesso.');
          if (error instanceof ReadAccessError) setCurrentUser(null);
        }
      } finally { busy = false; }
    };
    void validate();
    const focus = () => { if (!document.hidden) void validate(); };
    const revoked = () => {
      // Fence even a validation transport that ignores AbortSignal. A focus event
      // cannot resume this generation; only the explicit retry creates a new one.
      abort.abort();
      setCurrentUser(null); setFailure('Seu acesso mudou. Entre novamente para continuar.');
    };
    window.addEventListener('focus', focus); window.addEventListener('talk:access-revoked', revoked);
    return () => { abort.abort(); window.removeEventListener('focus', focus); window.removeEventListener('talk:access-revoked', revoked); };
  }, [stableToken, retry]);
  if (!currentUser) return <div className="center-state" role="status">{failure ?? 'Carregando atendimento…'}{failure ? <button type="button" onClick={() => setRetry(n => n + 1)}>Tentar novamente</button> : null}</div>;
  return <SessionScope key={`${identity}:${currentUser.workspaceId}:${currentUser.role}`} identity={identity} currentUser={currentUser} getToken={stableToken}>{failure ? <div className="list-note" role="status">{failure}</div> : null}{children}</SessionScope>;
}
function SessionScope({ children, identity, currentUser, getToken }: PropsWithChildren<{ identity: string; currentUser: CurrentTalkUserDto; getToken: () => Promise<string | null> }>) {
  const [session] = useState(() => new TalkSession(`${identity}:${currentUser.workspaceId}`, currentUser.workspaceId));
  const [realtime] = useState(() => new RealtimeConnection(() => session.reconcile(), () => {
    session.clear(); window.dispatchEvent(new Event('talk:access-revoked'));
  }, () => getToken()));
  const [context] = useState<SessionContextValue>(() => ({ session, realtime, currentUser, getToken }));
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const token = await withReadDeadline(controller.signal, () => getToken());
        if (active) {
          realtime.updateToken(token);
          if (!token) { session.clear(); window.dispatchEvent(new Event('talk:access-revoked')); }
        }
      } catch { if (active) realtime.updateToken(null); }
    };
    const unsubscribe = realtime.subscribe(event => session.event(event));
    const revoked = () => { active = false; controller.abort(); realtime.stop(); session.clear(); };
    window.addEventListener('talk:access-revoked', revoked);
    void refresh(); const timer = setInterval(() => void refresh(), 45_000);
    const focus = () => { if (!document.hidden) { void refresh(); session.reconcile(); } };
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => {
      active = false; controller.abort(); clearInterval(timer); unsubscribe(); realtime.stop(); session.clear();
      window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus);
      window.removeEventListener('talk:access-revoked', revoked);
    };
  }, [session, realtime, getToken]);
  return <TalkSessionContext.Provider value={context}><QueryClientProvider client={session.client}>
    <ContactPhotoProvider getToken={getToken} cache={session.blobs}>{children}</ContactPhotoProvider>
  </QueryClientProvider></TalkSessionContext.Provider>;
}
